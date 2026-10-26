'use strict';

// Previsão de entrada de contêineres.
//
//   1. DSS (Portal de Navios do TMS): atracações por terminal, com previsão de chegada/atracação,
//      deadline, abertura de gate e liberação de dry/reefer. É a fonte principal quando configurada.
//   2. Shipxy (AIS): navios com ETA para o porto. Cruzado com o DSS pelo nome do navio, confirma a
//      previsão de chegada pela posição real do navio e traz MMSI/IMO. Sem DSS, vira a lista principal.
//   3. Contêineres monitorados (cadastro próprio) são ligados aos navios por MMSI, IMO ou nome.
//   4. Diferenças acima da tolerância viram "divergências" para conferência:
//        - chegada prevista no DSS × ETA do AIS;
//        - ETA do eTracking do contêiner × chegada do navio (se houver fonte de eTracking).

const config = require('../config');
const shipxy = require('./shipxy');
const dss = require('./dss');
const { semBruto } = require('./conteineres');
const { ErroApi } = require('../util');

const HORA = 3600 * 1000;

function normalizarNome(nome) {
  return String(nome || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function pertenceAoNavio(conteiner, navio) {
  if (conteiner.navioMmsi && navio.mmsi && conteiner.navioMmsi === navio.mmsi) return true;
  if (conteiner.navioImo && navio.imo && conteiner.navioImo === navio.imo) return true;
  const a = normalizarNome(conteiner.navioNome);
  return Boolean(a) && a === normalizarNome(navio.nome);
}

function dia(iso) {
  return iso ? String(iso).slice(0, 10) : 'sem-data';
}

function horasEntre(depois, antes) {
  if (!depois || !antes) return null;
  const a = Date.parse(depois);
  const b = Date.parse(antes);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round(((a - b) / HORA) * 10) / 10;
}

function resumoAis(n) {
  return { mmsi: n.mmsi, imo: n.imo, eta: n.eta, destino: n.destino, posicao: n.posicao };
}

/** A atracação do DSS entra na janela? (prevista dentro dela, atrasada há até 1 dia, ou atracada agora) */
function naJanela(a, inicio, fim) {
  const ref = a.referencia ? Date.parse(a.referencia) : NaN;
  if (a.situacao === 'atracado') {
    const saida = a.datas.prevSaida ? Date.parse(a.datas.prevSaida) : NaN;
    return Number.isNaN(saida) ? ref >= inicio.getTime() - 3 * 24 * HORA : saida >= inicio.getTime();
  }
  return !Number.isNaN(ref) && ref >= inicio.getTime() - 24 * HORA && ref <= fim.getTime();
}

async function consultar(fonte, ativa, fn, avisos) {
  if (!ativa) return null;
  try {
    return await fn();
  } catch (erro) {
    avisos.push({ fonte, mensagem: erro.message, ...(erro.detalhes ? { detalhes: erro.detalhes } : {}) });
    return null;
  }
}

async function preverEntrada(store, { porto, dias, terminal, incluirBruto = false }) {
  const inicio = new Date();
  const fim = new Date(inicio.getTime() + dias * 24 * HORA);
  const avisos = [];

  const usarDss = dss.configurado() || config.modoDemo;
  const usarAis = shipxy.configurada() || config.modoDemo;
  if (!usarDss && !usarAis) {
    throw new ErroApi('Nenhuma fonte de navios configurada. Defina DSS_URL (ou NAVIOS_OF_DSS) e/ou SHIPXY_API_KEY.', {
      status: 503,
    });
  }

  const [atracacoes, chegadas] = await Promise.all([
    consultar('dss', usarDss, () => dss.atracacoes(), avisos),
    consultar('shipxy', usarAis, () => shipxy.chegadasPrevistas(porto, inicio, fim), avisos),
  ]);
  if (!atracacoes && !chegadas) {
    throw new ErroApi('Nenhuma fonte de navios respondeu.', { status: 502, detalhes: avisos });
  }

  const monitorados = (await store.listarConteineres()).filter((c) => c.situacao === 'monitorando');
  const divergencias = [];
  const usados = new Set();
  const aisUsados = new Set();
  const aisPorNome = new Map((chegadas?.dados || []).map((n) => [normalizarNome(n.nome), n]));

  function ligarConteineres(navio) {
    return monitorados
      .filter((c) => pertenceAoNavio(c, navio))
      .map((c) => {
        usados.add(c.numero);
        const diferencaHoras = horasEntre(c.etaEtracking, navio.eta);
        if (diferencaHoras !== null && Math.abs(diferencaHoras) > config.toleranciaDivergenciaHoras) {
          divergencias.push({
            tipo: 'conteiner-etracking',
            conteiner: c.numero,
            navio: navio.nome,
            chegadaNavio: navio.eta,
            etaEtracking: c.etaEtracking,
            diferencaHoras,
          });
        }
        return {
          numero: c.numero,
          armador: c.armador,
          descricao: c.descricao,
          perigoso: c.perigoso,
          classeRisco: c.classeRisco,
          etaEtracking: c.etaEtracking,
          diferencaHorasParaEtaNavio: diferencaHoras,
          ultimoRastreioEm: c.ultimoRastreioEm,
        };
      });
  }

  function montar(navio) {
    const conteineres = ligarConteineres(navio);
    return { ...navio, totalConteineres: conteineres.length, conteineres };
  }

  // 1. Navios do DSS (fonte principal), enriquecidos com o AIS.
  let navios = [];
  if (atracacoes) {
    const filtroTerminal = terminal ? String(terminal).toLowerCase() : null;
    navios = atracacoes.dados
      .filter((a) => !filtroTerminal || String(a.terminal || '').toLowerCase() === filtroTerminal)
      .filter((a) => naJanela(a, inicio, fim))
      .map((a) => {
        const ais = aisPorNome.get(normalizarNome(a.navio)) || null;
        if (ais) aisUsados.add(ais);
        const chegada = a.datas.prevChegada || a.datas.prevAtracacao || a.datas.atracacao;
        const diferencaAisHoras = ais ? horasEntre(ais.eta, chegada) : null;
        if (diferencaAisHoras !== null && Math.abs(diferencaAisHoras) > config.toleranciaDivergenciaHoras) {
          divergencias.push({
            tipo: 'chegada-dss-x-ais',
            navio: a.navio,
            viagem: a.viagem,
            chegadaDss: chegada,
            etaAis: ais.eta,
            diferencaHoras: diferencaAisHoras,
          });
        }
        return montar({
          fonte: 'dss',
          nome: a.navio,
          viagem: a.viagem,
          armador: a.armador,
          terminal: a.terminal,
          situacao: a.situacao,
          eta: chegada,
          datas: a.datas,
          mmsi: ais?.mmsi || null,
          imo: ais?.imo || null,
          ais: ais ? resumoAis(ais) : null,
          diferencaHorasAisParaDss: diferencaAisHoras,
        });
      });
  }

  // 2. Navios só no AIS. Sem DSS, são a lista principal; com DSS, vão para uma lista à parte
  //    (podem ser de outros terminais do porto).
  const somenteAis = (chegadas?.dados || [])
    .filter((n) => !aisUsados.has(n))
    .map((n) =>
      montar({
        fonte: 'shipxy',
        nome: n.nome,
        viagem: null,
        armador: null,
        terminal: null,
        situacao: 'previsto',
        eta: n.eta,
        datas: null,
        mmsi: n.mmsi,
        imo: n.imo,
        ais: resumoAis(n),
        diferencaHorasAisParaDss: null,
      }),
    );
  let naviosSomenteAis = [];
  if (atracacoes) naviosSomenteAis = somenteAis;
  else navios = somenteAis;

  navios.sort((a, b) => String(a.eta || '9999').localeCompare(String(b.eta || '9999')));

  // 3. Contêineres que o eTracking diz chegar a este porto na janela, sem navio correspondente.
  const semNavioNaLista = monitorados
    .filter((c) => !usados.has(c.numero))
    .filter((c) => c.locodeDestino === porto && c.etaEtracking)
    .filter((c) => {
      const t = Date.parse(c.etaEtracking);
      return t >= inicio.getTime() && t <= fim.getTime();
    })
    .map(semBruto);

  const porDia = {};
  const somar = (d, navios, conteineres) => {
    porDia[d] = porDia[d] || { navios: 0, conteineres: 0 };
    porDia[d].navios += navios;
    porDia[d].conteineres += conteineres;
  };
  for (const n of navios) somar(dia(n.eta), 1, n.totalConteineres);
  for (const n of naviosSomenteAis) if (n.totalConteineres) somar(dia(n.eta), 0, n.totalConteineres);
  for (const c of semNavioNaLista) somar(dia(c.etaEtracking), 0, 1);

  const contar = (lista) => lista.reduce((s, n) => s + n.totalConteineres, 0);

  return {
    porto,
    terminal: terminal || null,
    janela: { inicio: inicio.toISOString(), fim: fim.toISOString(), dias },
    fontes: {
      atracacoes: atracacoes ? atracacoes.fonte : usarDss ? 'erro' : 'não configurado',
      ais: chegadas ? chegadas.fonte : usarAis ? 'erro' : 'não configurado',
    },
    avisos,
    resumo: {
      totalNavios: navios.length,
      naviosComConteineresMonitorados: navios.filter((n) => n.totalConteineres > 0).length,
      naviosSomenteAis: naviosSomenteAis.length,
      totalConteineresPrevistos: contar(navios) + contar(naviosSomenteAis) + semNavioNaLista.length,
      totalDivergencias: divergencias.length,
      porDia,
    },
    navios,
    naviosSomenteAis,
    semNavioNaLista,
    divergencias,
    ...(incluirBruto ? { bruto: { dss: atracacoes?.bruto ?? null, shipxy: chegadas?.bruto ?? null } } : {}),
  };
}

module.exports = { preverEntrada, pertenceAoNavio, naJanela };

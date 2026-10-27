'use strict';

// Previsão de entrada de contêineres a partir das atracações do DSS (Portal de Navios do TMS).
//
//   1. O DSS devolve as atracações por terminal: chegada e atracação previstas, deadline,
//      abertura de gate, liberação de dry e reefer (todas as datas em UTC).
//   2. Entram na janela as atracações previstas de agora (com 1 dia de tolerância para atrasos)
//      até o fim do período, e os navios atracados cuja saída prevista ainda não passou.
//   3. Os contêineres monitorados (cadastro próprio) são ligados à atracação pelo nome do navio
//      e, se informada, pela viagem.

const dss = require('./dss');

const HORA = 3600 * 1000;

function normalizar(texto) {
  return String(texto || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** O contêiner vem nesta atracação? Mesmo navio e, se o cadastro tiver viagem, mesma viagem. */
function pertenceAAtracacao(conteiner, atracacao) {
  const nome = normalizar(conteiner.navioNome);
  if (!nome || nome !== normalizar(atracacao.navio)) return false;
  const viagem = normalizar(conteiner.navioViagem);
  return !viagem || viagem === normalizar(atracacao.viagem);
}

/** A atracação entra na janela? */
function naJanela(a, inicio, fim) {
  const ref = a.referencia ? Date.parse(a.referencia) : NaN;
  if (a.situacao === 'atracado') {
    const saida = a.datas.prevSaida ? Date.parse(a.datas.prevSaida) : NaN;
    return Number.isNaN(saida) ? ref >= inicio.getTime() - 3 * 24 * HORA : saida >= inicio.getTime();
  }
  return !Number.isNaN(ref) && ref >= inicio.getTime() - 24 * HORA && ref <= fim.getTime();
}

function dia(iso) {
  return iso ? String(iso).slice(0, 10) : 'sem-data';
}

async function preverEntrada(store, { dias, terminal, incluirBruto = false }) {
  const inicio = new Date();
  const fim = new Date(inicio.getTime() + dias * 24 * HORA);

  const atracacoes = await dss.atracacoes();
  const monitorados = (await store.listarConteineres()).filter((c) => c.situacao === 'monitorando');
  const filtroTerminal = terminal ? String(terminal).toLowerCase() : null;
  const usados = new Set();

  const navios = atracacoes.dados
    .filter((a) => !filtroTerminal || String(a.terminal || '').toLowerCase() === filtroTerminal)
    .filter((a) => naJanela(a, inicio, fim))
    .map((a) => {
      const conteineres = monitorados
        .filter((c) => pertenceAAtracacao(c, a))
        .map((c) => {
          usados.add(c.numero);
          return {
            numero: c.numero,
            armador: c.armador,
            descricao: c.descricao,
            perigoso: c.perigoso,
            classeRisco: c.classeRisco,
          };
        });
      return { ...a, chegada: a.datas.prevChegada || a.datas.prevAtracacao || a.datas.atracacao, totalConteineres: conteineres.length, conteineres };
    });

  const porDia = {};
  for (const n of navios) {
    const d = dia(n.chegada);
    porDia[d] = porDia[d] || { navios: 0, conteineres: 0 };
    porDia[d].navios += 1;
    porDia[d].conteineres += n.totalConteineres;
  }

  // Contêineres monitorados cujo navio não aparece na janela (navio fora do período, nome ou viagem diferentes).
  const semAtracacaoNaJanela = monitorados
    .filter((c) => !usados.has(c.numero))
    .map((c) => ({ numero: c.numero, navioNome: c.navioNome, navioViagem: c.navioViagem }));

  return {
    terminal: terminal || null,
    timezone: 'UTC',
    janela: { inicio: inicio.toISOString(), fim: fim.toISOString(), dias },
    fonte: atracacoes.fonte,
    resumo: {
      totalNavios: navios.length,
      atracados: navios.filter((n) => n.situacao === 'atracado').length,
      previstos: navios.filter((n) => n.situacao === 'previsto').length,
      naviosComConteineresMonitorados: navios.filter((n) => n.totalConteineres > 0).length,
      totalConteineresPrevistos: navios.reduce((s, n) => s + n.totalConteineres, 0),
      porDia,
    },
    navios,
    semAtracacaoNaJanela,
    ...(incluirBruto ? { bruto: atracacoes.bruto } : {}),
  };
}

module.exports = { preverEntrada, pertenceAAtracacao, naJanela };

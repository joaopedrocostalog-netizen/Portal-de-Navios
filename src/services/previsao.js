'use strict';

// Previsão de entrada de contêineres.
//
//   1. Fonte principal: atracações do DSS (Portal de Navios do TMS), com chegada e atracação previstas,
//      deadline, abertura de gate e liberação de dry e reefer (datas em UTC).
//   2. Se houver planilha da BTP importada, cada atracação do terminal BTP ganha os dados dela:
//      status (previsto / na barra / atracado / desatracado), RAP, berço, serviço, chegada e saída reais.
//      Se o DSS estiver indisponível, a planilha da BTP é usada como fonte, com aviso.
//   3. Entram na janela as atracações previstas de agora (com 1 dia de tolerância para atrasos)
//      até o fim do período, e os navios atracados cuja saída ainda não aconteceu.
//   4. Os contêineres monitorados são ligados à atracação pelo nome do navio e, se informada, pela viagem.

const dss = require('./dss');
const btp = require('./btp');

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
  if (a.situacao === 'desatracado') return false;
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

/** Registro da planilha da BTP no mesmo formato de uma atracação do DSS. */
function btpComoAtracacao(r) {
  return {
    navio: r.navio,
    viagem: r.viagem,
    armador: r.agencia,
    terminal: 'btp',
    situacao: r.saida ? 'desatracado' : r.atracacao ? 'atracado' : 'previsto',
    referencia: r.atracacao || r.prevAtracacao || r.prevChegada || r.deadline,
    datas: {
      deadline: r.deadline,
      prevChegada: r.prevChegada,
      prevAtracacao: r.prevAtracacao,
      atracacao: r.atracacao,
      prevSaida: r.prevSaida,
      prevAberturaGate: r.aberturaGateDry,
      aberturaGate: null,
      prevLiberacaoDry: null,
      liberacaoDry: null,
      prevLiberacaoReefer: null,
      liberacaoReefer: null,
    },
  };
}

function resumoBtp(r, viagemConfere) {
  return {
    status: r.status,
    rap: r.rap,
    berco: r.berco,
    servico: r.servico,
    chegada: r.chegada,
    saida: r.saida,
    aberturaGateDry: r.aberturaGateDry,
    aberturaGateReefer: r.aberturaGateReefer,
    viagemConfere,
  };
}

async function preverEntrada(store, { dias, terminal, incluirBruto = false }) {
  const inicio = new Date();
  const fim = new Date(inicio.getTime() + dias * 24 * HORA);
  const avisos = [];

  const importacao = store.ultimaImportacaoBtp ? await store.ultimaImportacaoBtp() : null;
  const acharBtp = importacao ? btp.indexar(importacao.registros) : null;

  let fonte = 'dss';
  let atracacoes;
  let bruto = null;
  try {
    const r = await dss.atracacoes();
    atracacoes = r.dados;
    bruto = r.bruto;
  } catch (erro) {
    if (!importacao) throw erro;
    fonte = 'planilha-btp';
    atracacoes = importacao.registros.map(btpComoAtracacao);
    avisos.push({
      fonte: 'dss',
      mensagem: `${erro.message} Usando a planilha da BTP importada em ${new Date(importacao.importadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })} (só terminal BTP).`,
    });
  }

  const monitorados = (await store.listarConteineres()).filter((c) => c.situacao === 'monitorando');
  const filtroTerminal = terminal ? String(terminal).toLowerCase() : null;
  const usados = new Set();

  const navios = atracacoes
    .filter((a) => !filtroTerminal || String(a.terminal || '').toLowerCase() === filtroTerminal)
    .map((a) => {
      // Dados da planilha da BTP para atracações do terminal BTP.
      const achado = acharBtp && String(a.terminal || '').toLowerCase() === 'btp' ? acharBtp(a.navio, a.viagem) : null;
      const comBtp = achado ? { ...a, btp: resumoBtp(achado.registro, achado.viagemConfere) } : { ...a, btp: null };
      // A BTP sabe quando o navio já saiu, mesmo que o DSS ainda não tenha atualizado.
      if (achado?.registro.saida && comBtp.situacao !== 'desatracado') comBtp.situacao = 'desatracado';
      return comBtp;
    })
    .filter((a) => naJanela(a, inicio, fim))
    .map((a) => {
      const conteineres = monitorados
        .filter((c) => pertenceAAtracacao(c, a))
        .map((c) => {
          usados.add(c.numero);
          return { numero: c.numero, armador: c.armador, descricao: c.descricao, perigoso: c.perigoso, classeRisco: c.classeRisco };
        });
      return {
        ...a,
        chegada: a.datas.prevChegada || a.datas.prevAtracacao || a.datas.atracacao,
        totalConteineres: conteineres.length,
        conteineres,
      };
    });

  const porDia = {};
  for (const n of navios) {
    const d = dia(n.chegada);
    porDia[d] = porDia[d] || { navios: 0, conteineres: 0 };
    porDia[d].navios += 1;
    porDia[d].conteineres += n.totalConteineres;
  }

  const semAtracacaoNaJanela = monitorados
    .filter((c) => !usados.has(c.numero))
    .map((c) => ({ numero: c.numero, navioNome: c.navioNome, navioViagem: c.navioViagem }));

  return {
    terminal: terminal || null,
    timezone: 'UTC',
    janela: { inicio: inicio.toISOString(), fim: fim.toISOString(), dias },
    fonte,
    planilhaBtp: importacao ? { importadoEm: importacao.importadoEm, nomeArquivo: importacao.nomeArquivo, total: importacao.total } : null,
    avisos,
    resumo: {
      totalNavios: navios.length,
      atracados: navios.filter((n) => n.situacao === 'atracado').length,
      previstos: navios.filter((n) => n.situacao === 'previsto').length,
      naBarra: navios.filter((n) => n.btp?.status === 'na_barra').length,
      naviosComConteineresMonitorados: navios.filter((n) => n.totalConteineres > 0).length,
      totalConteineresPrevistos: navios.reduce((s, n) => s + n.totalConteineres, 0),
      porDia,
    },
    navios,
    semAtracacaoNaJanela,
    ...(incluirBruto ? { bruto } : {}),
  };
}

module.exports = { preverEntrada, pertenceAAtracacao, naJanela, btpComoAtracacao };

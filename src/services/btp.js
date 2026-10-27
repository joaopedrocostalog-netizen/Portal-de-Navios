'use strict';

// Programação de atracação da BTP importada da planilha (botão "Download" em
// portaldocliente.btp.com.br › Processos logísticos › Consultas livres › Lista de atracação).
//
// Colunas reconhecidas pelo título (a ordem não importa):
//   RAP, Navio, Viagem, Agência, Dt. Prev. Chegada, Dt. Chegada, Dt. Prev. Atrac., Dt. Atracação,
//   Dt. Prev. Saída, Dt. Saída, Abertura de Gate Dry, Abertura de Gate Reefer, Dead-Line, Serviço, Berço.
//
// A BTP mostra as datas no horário de Brasília (UTC-3); aqui elas viram UTC, como as do DSS.
// Status igual ao da tela da BTP: saída → desatracado; atracação → atracado; chegada → na barra; senão previsto.

const { lerPlanilha } = require('./planilha');
const { ErroApi } = require('../util');

const HORA = 3600 * 1000;
const FUSO_BRASILIA_HORAS = 3; // Brasília = UTC-3 (sem horário de verão desde 2019)

function normalizarTitulo(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// título normalizado -> campo
const COLUNAS = {
  rap: 'rap',
  navio: 'navio',
  viagem: 'viagem',
  agencia: 'agencia',
  armador: 'agencia',
  dtprevchegada: 'prevChegada',
  previsaochegada: 'prevChegada',
  dtchegada: 'chegada',
  chegada: 'chegada',
  dtprevatrac: 'prevAtracacao',
  dtprevatracacao: 'prevAtracacao',
  previsaoatracacao: 'prevAtracacao',
  dtatracacao: 'atracacao',
  atracacao: 'atracacao',
  dtprevsaida: 'prevSaida',
  previsaosaida: 'prevSaida',
  dtsaida: 'saida',
  saida: 'saida',
  aberturadegatedry: 'aberturaGateDry',
  aberturagatedry: 'aberturaGateDry',
  aberturadegatereefer: 'aberturaGateReefer',
  aberturagatereefer: 'aberturaGateReefer',
  aberturadegaterefeer: 'aberturaGateReefer',
  deadline: 'deadline',
  deadlinecarga: 'deadline',
  servico: 'servico',
  berco: 'berco',
};

const CAMPOS_DATA = ['prevChegada', 'chegada', 'prevAtracacao', 'atracacao', 'prevSaida', 'saida', 'aberturaGateDry', 'aberturaGateReefer', 'deadline'];

/** Data da BTP (horário de Brasília) -> ISO em UTC. Aceita "dd/mm/aaaa hh:mm[:ss]", ISO e número de série do Excel. */
function dataBrasiliaParaUtc(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'number') {
    if (valor < 20000 || valor > 80000) return null; // fora de 1954–2119: não é data
    const ms = Math.round((valor - 25569) * 86400 * 1000) + FUSO_BRASILIA_HORAS * HORA;
    return new Date(Math.round(ms / 1000) * 1000).toISOString();
  }
  const texto = String(valor).trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(texto);
  if (m) {
    const [, d, mes, a, h = '0', mi = '0', s = '0'] = m;
    return new Date(Date.UTC(+a, +mes - 1, +d, +h + FUSO_BRASILIA_HORAS, +mi, +s)).toISOString();
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(texto);
  if (m) {
    const [, a, mes, d, h = '0', mi = '0', s = '0'] = m;
    return new Date(Date.UTC(+a, +mes - 1, +d, +h + FUSO_BRASILIA_HORAS, +mi, +s)).toISOString();
  }
  return null;
}

function texto(valor) {
  const t = String(valor ?? '').replace(/\s+/g, ' ').trim();
  return t || null;
}

function statusBtp(r) {
  if (r.saida) return 'desatracado';
  if (r.atracacao) return 'atracado';
  if (r.chegada) return 'na_barra';
  return 'previsto';
}

/** Converte as linhas da planilha em registros. */
function interpretarLinhas(linhas) {
  // Linha de títulos: a primeira com pelo menos 4 colunas reconhecidas, incluindo "Navio".
  let cabecalho = -1;
  let mapa = [];
  for (let i = 0; i < Math.min(linhas.length, 30); i += 1) {
    const campos = (linhas[i] || []).map((c) => COLUNAS[normalizarTitulo(c)] || null);
    if (campos.filter(Boolean).length >= 4 && campos.includes('navio')) {
      cabecalho = i;
      mapa = campos;
      break;
    }
  }
  if (cabecalho < 0) {
    throw new ErroApi('Não reconheci a planilha da BTP: falta a linha de títulos (RAP, Navio, Viagem, Dt. Prev. Chegada…).', {
      status: 400,
    });
  }

  const avisos = [];
  const registros = [];
  for (let i = cabecalho + 1; i < linhas.length; i += 1) {
    const linha = linhas[i] || [];
    const bruto = {};
    mapa.forEach((campo, j) => {
      if (campo && bruto[campo] === undefined) bruto[campo] = linha[j];
    });
    const navio = texto(bruto.navio);
    if (!navio) continue;
    const r = {
      rap: texto(bruto.rap),
      navio: navio.toUpperCase(),
      viagem: texto(bruto.viagem)?.toUpperCase() || null,
      agencia: texto(bruto.agencia),
      servico: texto(bruto.servico),
      berco: texto(bruto.berco),
    };
    for (const campo of CAMPOS_DATA) {
      const v = bruto[campo];
      r[campo] = dataBrasiliaParaUtc(v);
      if (v !== null && v !== undefined && String(v).trim() !== '' && !r[campo]) {
        avisos.push(`Linha ${i + 1}: data não reconhecida em ${campo} (${String(v).slice(0, 30)}).`);
      }
    }
    r.status = statusBtp(r);
    registros.push(r);
  }
  if (!registros.length) throw new ErroApi('A planilha da BTP não tem navios abaixo dos títulos.', { status: 400 });
  return { registros, avisos: avisos.slice(0, 20), colunas: mapa.filter(Boolean) };
}

function importarPlanilha(buffer) {
  const { formato, linhas } = lerPlanilha(buffer);
  return { formato, ...interpretarLinhas(linhas) };
}

function contarStatus(registros) {
  const contagem = { previsto: 0, na_barra: 0, atracado: 0, desatracado: 0 };
  for (const r of registros) contagem[r.status] += 1;
  return contagem;
}

// ---------------------------------------------------------------------------- comparação com o DSS
function normalizar(valor) {
  return String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function chave(navio, viagem) {
  return `${normalizar(navio)}|${normalizar(viagem)}`;
}

/** Índice para achar o registro da BTP de uma atracação do DSS (navio + viagem; só navio se for único). */
function indexar(registrosBtp) {
  const porChave = new Map();
  const porNavio = new Map();
  for (const r of registrosBtp) {
    porChave.set(chave(r.navio, r.viagem), r);
    const n = normalizar(r.navio);
    porNavio.set(n, porNavio.has(n) ? null : r); // null = navio com mais de uma viagem
  }
  return (navio, viagem) => {
    const exato = porChave.get(chave(navio, viagem));
    if (exato) return { registro: exato, viagemConfere: true };
    const soNavio = porNavio.get(normalizar(navio));
    return soNavio ? { registro: soNavio, viagemConfere: false } : null;
  };
}

// campo da BTP -> como obter o mesmo dado no DSS
const PARES = [
  ['prevChegada', 'Previsão de chegada', (d) => d.prevChegada],
  ['prevAtracacao', 'Previsão de atracação', (d) => d.prevAtracacao],
  ['atracacao', 'Atracação', (d) => d.atracacao],
  ['prevSaida', 'Previsão de saída', (d) => d.prevSaida],
  ['deadline', 'Deadline', (d) => d.deadline],
  ['aberturaGateDry', 'Abertura de gate (dry)', (d) => d.aberturaGate || d.prevAberturaGate],
];

function horasEntre(a, b) {
  return Math.round(((Date.parse(a) - Date.parse(b)) / HORA) * 10) / 10;
}

/**
 * Compara a planilha da BTP com as atracações do DSS do terminal BTP.
 * Diferenças acima de `toleranciaHoras` (ou dado presente só de um lado) viram divergências.
 */
function compararComDss(registrosBtp, atracacoesDss, { toleranciaHoras = 1 } = {}) {
  const dssBtp = atracacoesDss.filter((a) => String(a.terminal || '').toLowerCase() === 'btp');
  const achar = indexar(registrosBtp);
  const usadosBtp = new Set();
  const divergencias = [];
  const conferidos = [];
  const somenteDss = [];

  for (const a of dssBtp) {
    const achado = achar(a.navio, a.viagem);
    if (!achado) {
      somenteDss.push({ navio: a.navio, viagem: a.viagem, referencia: a.referencia });
      continue;
    }
    const b = achado.registro;
    usadosBtp.add(b);
    const diferencas = [];
    for (const [campoBtp, rotulo, doDss] of PARES) {
      const vBtp = b[campoBtp];
      const vDss = doDss(a.datas);
      if (!vBtp && !vDss) continue;
      if (!vBtp || !vDss) {
        diferencas.push({ campo: rotulo, btp: vBtp, dss: vDss, diferencaHoras: null });
        continue;
      }
      const dif = horasEntre(vDss, vBtp);
      if (Math.abs(dif) > toleranciaHoras) diferencas.push({ campo: rotulo, btp: vBtp, dss: vDss, diferencaHoras: dif });
    }
    conferidos.push({ navio: a.navio, viagem: a.viagem, viagemBtp: b.viagem, viagemConfere: achado.viagemConfere, statusBtp: b.status, divergente: diferencas.length > 0 });
    if (diferencas.length || !achado.viagemConfere) {
      divergencias.push({
        navio: a.navio,
        viagemDss: a.viagem,
        viagemBtp: b.viagem,
        rap: b.rap,
        statusBtp: b.status,
        ...(achado.viagemConfere ? {} : { aviso: 'Viagem diferente entre DSS e BTP; casado só pelo nome do navio.' }),
        diferencas,
      });
    }
  }

  const somenteBtp = registrosBtp
    .filter((r) => !usadosBtp.has(r) && r.status !== 'desatracado')
    .map((r) => ({ navio: r.navio, viagem: r.viagem, rap: r.rap, status: r.status, prevAtracacao: r.prevAtracacao }));

  return {
    toleranciaHoras,
    resumo: {
      naPlanilha: registrosBtp.length,
      noDssBtp: dssBtp.length,
      conferidos: conferidos.length,
      comDivergencia: divergencias.length,
      somenteNaPlanilha: somenteBtp.length,
      somenteNoDss: somenteDss.length,
    },
    divergencias,
    somenteNaPlanilha: somenteBtp,
    somenteNoDss: somenteDss,
  };
}

module.exports = { importarPlanilha, interpretarLinhas, dataBrasiliaParaUtc, compararComDss, contarStatus, indexar };

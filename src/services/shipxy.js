'use strict';

// Integração com a Shipxy (posição AIS de navios e navios previstos para chegar a um porto).
// Documentação: https://apidocs.shipxy.com
//   - GetSingleShip  -> posição de um navio por MMSI
//   - GetETAShips    -> navios com ETA para um porto (serviço avançado: a chave precisa dessa permissão)
//   - SearchPort     -> busca o código de porto da Shipxy pelo nome

const config = require('../config');
const { obterJson } = require('./http');
const { ErroApi, paraIso } = require('../util');
const demo = require('./demo');

const ROTULO = 'Shipxy';

function configurada() {
  return Boolean(config.shipxyKey);
}

/** Sem chave: em modo demonstração devolve true (usar demo); senão avisa que falta a chave. */
function usarDemo() {
  if (configurada()) return false;
  if (config.modoDemo) return true;
  throw new ErroApi('Shipxy não configurada: defina SHIPXY_API_KEY.', { status: 503, fonte: 'shipxy' });
}

async function chamar(metodo, parametros) {
  const url = new URL(`${config.shipxyBaseUrl}/${metodo}`);
  url.searchParams.set('key', config.shipxyKey);
  for (const [nome, valor] of Object.entries(parametros)) {
    if (valor !== undefined && valor !== null && valor !== '') url.searchParams.set(nome, String(valor));
  }

  const { status, corpo } = await obterJson(url, { timeoutMs: config.timeoutHttpMs, rotulo: ROTULO });

  if (status !== 200) {
    throw new ErroApi(`${ROTULO} respondeu HTTP ${status}.`, { status: 502, fonte: 'shipxy', detalhes: corpo });
  }
  // A Shipxy sempre responde HTTP 200 e informa o resultado no campo "status" (0 = sucesso).
  // Ex.: a chave de exemplo da documentação devolve status 14 (sem permissão).
  if (!corpo || Number(corpo.status) !== 0) {
    throw new ErroApi(`${ROTULO} recusou a consulta: ${corpo?.msg || 'resposta inesperada'}.`, {
      status: 502,
      fonte: 'shipxy',
      detalhes: corpo ? { status: corpo.status, msg: corpo.msg } : null,
    });
  }
  return corpo;
}

/** Converte um registro da Shipxy para o formato do Portal de Navios. */
function normalizarNavio(s) {
  const temPosicao = s.lat !== undefined && s.lat !== null && s.lng !== undefined && s.lng !== null;
  return {
    mmsi: s.mmsi !== undefined && s.mmsi !== null ? String(s.mmsi) : null,
    imo: s.imo ? String(s.imo) : null,
    nome: s.ship_name || null,
    tipo: s.ship_type ?? null,
    bandeira: s.ship_flag || null,
    comprimento: s.length ?? null,
    largura: s.width ?? null,
    calado: s.draught ?? null,
    dwt: s.dwt ?? null,
    posicao: temPosicao
      ? {
          lat: Number(s.lat),
          lon: Number(s.lng),
          // "sog"/"cog" são repassados como a Shipxy envia; confira a unidade na resposta bruta.
          velocidade: s.sog ?? null,
          rumo: s.cog ?? null,
          atualizadoEm: paraIso(s.last_time_utc ?? s.last_time),
        }
      : null,
    destino: s.dest || null,
    codigoDestino: s.destcode || null,
    eta: paraIso(s.eta_utc ?? s.eta),
    portoAnterior: s.preport_cnname || null,
    statusNavegacao: s.navistat ?? null,
  };
}

function comoLista(dados) {
  if (Array.isArray(dados)) return dados;
  if (dados && typeof dados === 'object') return [dados];
  return [];
}

/** Posição atual de um navio pelo MMSI. */
async function buscarNavio(mmsi) {
  if (usarDemo()) return { fonte: 'demo', dados: demo.navioPorMmsiDemo(mmsi), bruto: null };
  const corpo = await chamar('GetSingleShip', { mmsi });
  const registro = comoLista(corpo.data)[0];
  if (!registro) throw new ErroApi(`Navio com MMSI ${mmsi} não encontrado na Shipxy.`, { status: 404, fonte: 'shipxy' });
  return { fonte: 'shipxy', dados: normalizarNavio(registro), bruto: corpo };
}

/** Navios com chegada prevista ao porto entre `inicio` e `fim`, ordenados por ETA. */
async function chegadasPrevistas(porto, inicio, fim) {
  let fonte = 'shipxy';
  let navios;
  let bruto = null;
  if (usarDemo()) {
    fonte = 'demo';
    navios = demo.chegadasDemo(porto, inicio, fim);
  } else {
    bruto = await chamar('GetETAShips', {
      port_code: porto,
      start_time: Math.floor(inicio.getTime() / 1000),
      end_time: Math.floor(fim.getTime() / 1000),
    });
    navios = comoLista(bruto.data).map(normalizarNavio);
  }
  navios.sort((a, b) => String(a.eta || '').localeCompare(String(b.eta || '')));
  return { fonte, dados: navios, bruto };
}

function normalizarPorto(p) {
  return {
    codigo: p.port_code || null,
    nome: p.port_name || null,
    nomeChines: p.port_cnname || null,
    pais: p.port_country_name || null,
    codigoPais: p.port_country_code || null,
    fusoHorario: p.port_time_zone ?? null,
  };
}

/**
 * Busca portos por nome (inglês ou chinês) ou código de 5 letras.
 * A Shipxy usa códigos próprios (ex.: Qingdao = CNQDG), que podem diferir do UN/LOCODE oficial;
 * use o `codigo` devolvido aqui nas outras consultas de porto.
 */
async function buscarPortos(termo, max = 10) {
  if (usarDemo()) {
    return { fonte: 'demo', dados: [{ codigo: 'BRSSZ', nome: 'Santos (demo)', nomeChines: null, pais: 'Brazil', codigoPais: 'BR', fusoHorario: '-3' }], bruto: null };
  }
  const corpo = await chamar('SearchPort', { keywords: termo, max });
  return { fonte: 'shipxy', dados: comoLista(corpo.data).map(normalizarPorto), bruto: corpo };
}

module.exports = { configurada, buscarNavio, chegadasPrevistas, buscarPortos, normalizarNavio };

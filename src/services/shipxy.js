'use strict';

// Integração com a Shipxy (posição AIS de navios e navios previstos para chegar a um porto).
// Documentação: https://apidocs.shipxy.com
//   - GetSingleShip  -> posição de um navio por MMSI
//   - GetETAShips    -> navios com ETA para um porto (serviço avançado: a chave precisa dessa permissão)

const config = require('../config');
const { obterJson } = require('./http');
const { ErroApi, paraIso } = require('../util');
const demo = require('./demo');

const ROTULO = 'Shipxy';

function configurada() {
  return Boolean(config.shipxyKey);
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
  if (!configurada()) return { fonte: 'demo', dados: demo.navioPorMmsiDemo(mmsi), bruto: null };
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
  if (!configurada()) {
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

module.exports = { configurada, buscarNavio, chegadasPrevistas, normalizarNavio };

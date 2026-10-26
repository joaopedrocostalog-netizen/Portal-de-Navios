'use strict';

// eTracking de contêineres pela VesselFinder Container Tracking API.
// GET https://container.vesselfinder.com/api/1.0/container/{apiKey}/{containerNumber}/{sealine}
//   200 -> dados prontos
//   202 -> consulta na fila; repetir depois de "retryAfter" segundos (no mínimo 60 s)
//   400 número/SCAC inválido ou limite de requisições | 401 chave inválida
//   402 limite da assinatura | 409 erro no armador

const config = require('../config');
const { obterJson } = require('./http');
const { ErroApi, paraIso } = require('../util');
const demo = require('./demo');

const ROTULO = 'VesselFinder';

function configurada() {
  return Boolean(config.vesselfinderKey);
}

function texto(valor) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor === 'object') return valor.name || valor.port || valor.locode || JSON.stringify(valor);
  return String(valor);
}

function locodeDe(valor) {
  if (valor && typeof valor === 'object' && valor.locode) return String(valor.locode).toUpperCase();
  const achado = /\b([A-Z]{2}[A-Z0-9]{3})\b/.exec(String(valor || ''));
  return achado ? achado[1] : null;
}

/** Converte a resposta 200 da VesselFinder para o formato do Portal de Navios. */
function normalizarRastreio(numero, corpo) {
  const geral = corpo.general || {};
  const navio = corpo.vessel || null;
  const eventos = (Array.isArray(corpo.schedule) ? corpo.schedule : []).map((e) => ({
    porto: texto(e.port),
    locode: e.locode ? String(e.locode).toUpperCase() : null,
    evento: texto(e.event),
    dataHora: paraIso(e.timestamp),
    realizado: Boolean(e.actual),
    navio: texto(e.vessel),
  }));

  const locodeDestino = locodeDe(geral.destination);
  // ETA de destino: o último evento ainda não realizado no porto de destino
  // (ou, se o destino não tiver locode, o último evento não realizado).
  const pendentes = eventos.filter((e) => !e.realizado && e.dataHora);
  const noDestino = locodeDestino ? pendentes.filter((e) => e.locode === locodeDestino) : [];
  const referencia = (noDestino.length ? noDestino : pendentes).at(-1) || null;

  return {
    numero,
    armador: texto(geral.carrier),
    scac: texto(geral.sealine),
    origem: texto(geral.origin),
    destino: texto(geral.destination),
    progresso: geral.progress ?? null,
    localAtual: texto(geral.currentLocation),
    navio: navio
      ? {
          nome: navio.name || null,
          imo: navio.imo ? String(navio.imo) : null,
          mmsi: navio.mmsi ? String(navio.mmsi) : null,
          posicao:
            navio.latitude !== undefined && navio.longitude !== undefined
              ? { lat: Number(navio.latitude), lon: Number(navio.longitude) }
              : null,
          velocidade: navio.speed ?? null,
          rumo: navio.course ?? null,
        }
      : null,
    eventos,
    etaDestino: referencia ? referencia.dataHora : null,
    locodeDestino,
  };
}

/**
 * Consulta o eTracking de um contêiner.
 * Retorna { fonte, pronto, dados?, situacao?, tenteNovamenteEmSegundos?, bruto }.
 */
async function rastrear(numero, armador = 'AUTO') {
  if (!configurada()) {
    return { fonte: 'demo', pronto: true, dados: demo.rastreioDemo(numero, armador, config.portoPadrao), bruto: null };
  }

  const url =
    `${config.vesselfinderBaseUrl}/container/` +
    `${encodeURIComponent(config.vesselfinderKey)}/${encodeURIComponent(numero)}/${encodeURIComponent(armador)}`;
  const { status, corpo } = await obterJson(url, { timeoutMs: config.timeoutHttpMs, rotulo: ROTULO });

  if (status === 200 && corpo && corpo.status !== 'error') {
    return { fonte: 'vesselfinder', pronto: true, dados: normalizarRastreio(numero, corpo), bruto: corpo };
  }
  if (status === 202 || corpo?.status === 'queued' || corpo?.status === 'processing') {
    return {
      fonte: 'vesselfinder',
      pronto: false,
      situacao: corpo?.status || 'queued',
      tenteNovamenteEmSegundos: Math.max(60, Number(corpo?.retryAfter) || 60),
      bruto: corpo,
    };
  }

  if (status === 200) {
    throw new ErroApi(`VesselFinder retornou erro: ${corpo?.message || 'resposta inesperada'}.`, {
      status: 502,
      fonte: 'vesselfinder',
      detalhes: corpo,
    });
  }

  const mensagens = {
    400: ['Número do contêiner/SCAC rejeitado pela VesselFinder ou limite de requisições atingido.', 400],
    401: ['Chave VESSELFINDER_API_KEY inválida ou expirada.', 502],
    402: ['Limite da assinatura VesselFinder atingido.', 502],
    409: ['O armador informado retornou erro para este contêiner.', 409],
  };
  const [mensagem, codigo] = mensagens[status] || [`${ROTULO} respondeu HTTP ${status}.`, 502];
  throw new ErroApi(mensagem, { status: codigo, fonte: 'vesselfinder', detalhes: corpo });
}

module.exports = { configurada, rastrear, normalizarRastreio };

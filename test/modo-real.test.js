'use strict';

// Fluxo com a Shipxy ligada e sem fonte de eTracking (situação de produção atual).
// As chamadas à Shipxy são simuladas; as chamadas ao servidor local passam direto.
process.env.SHIPXY_API_KEY = 'chave-teste';
process.env.DATABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('../src/server');
const { criarArmazenamento } = require('../src/db');

const fetchOriginal = global.fetch;
const HORA = 3600 * 1000;

global.fetch = async (url, opcoes) => {
  const alvo = new URL(String(url));
  if (alvo.hostname !== 'api.shipxy.com') return fetchOriginal(url, opcoes);
  const eta = Math.floor((Date.now() + 30 * HORA) / 1000);
  const corpo = alvo.pathname.endsWith('/GetETAShips')
    ? { status: 0, msg: 'ok', total: 1, data: [{ mmsi: 123456789, imo: 9876543, ship_name: 'MSC ANNA', eta_utc: eta, dest: 'SANTOS' }] }
    : { status: 5, msg: 'serviço não simulado' };
  return new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } });
};

let srv;
let base;

test.before(async () => {
  srv = await iniciar({ porta: 0, store: criarArmazenamento('') });
  base = `http://127.0.0.1:${srv.porta}`;
});

test.after(async () => {
  await srv.encerrar();
  global.fetch = fetchOriginal;
});

async function chamar(caminho, opcoes = {}) {
  const res = await fetch(base + caminho, { ...opcoes, headers: { 'content-type': 'application/json' } });
  const texto = await res.text();
  return { status: res.status, corpo: texto ? JSON.parse(texto) : null };
}

test('não cadastra contêineres de demonstração quando a Shipxy está ligada', async () => {
  const { corpo } = await chamar('/api/conteineres');
  assert.equal(corpo.total, 0);
  const health = await chamar('/api/health');
  assert.equal(health.corpo.fontes.shipxy, 'configurada');
  assert.match(health.corpo.fontes.etracking, /nenhuma fonte/);
});

test('contêiner cadastrado com o nome do navio entra na previsão', async () => {
  const novo = await chamar('/api/conteineres', {
    method: 'POST',
    body: JSON.stringify({ numero: 'MSCU1234566', armador: 'MSCU', navioNome: 'msc anna', perigoso: true }),
  });
  assert.equal(novo.status, 201);
  assert.equal(novo.corpo.sincronizacao, undefined, 'sem eTracking não tenta sincronizar');

  const { status, corpo } = await chamar('/api/previsao-entrada?porto=BRSSZ&dias=7');
  assert.equal(status, 200);
  assert.equal(corpo.fontes.navios, 'shipxy');
  assert.equal(corpo.navios[0].nome, 'MSC ANNA');
  assert.equal(corpo.navios[0].totalConteineres, 1);
  assert.equal(corpo.navios[0].conteineres[0].perigoso, true);
  assert.equal(corpo.resumo.totalConteineresPrevistos, 1);
});

test('consulta de eTracking explica que não há fonte ligada', async () => {
  const { status, corpo } = await chamar('/api/conteineres/MSCU1234566/rastreio');
  assert.equal(status, 501);
  assert.match(corpo.erro, /Nenhuma fonte de eTracking/);
});

test('erro da Shipxy chega ao cliente com a mensagem dela', async () => {
  const { status, corpo } = await chamar('/api/portos?busca=santos');
  assert.equal(status, 502);
  assert.match(corpo.erro, /serviço não simulado/);
  assert.equal(corpo.detalhes.status, 5);
});

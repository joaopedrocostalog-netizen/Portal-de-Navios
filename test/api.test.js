'use strict';

// Testes da API em modo demonstração (sem chaves e sem banco).
process.env.SHIPXY_API_KEY = '';
process.env.VESSELFINDER_API_KEY = '';
process.env.DATABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { iniciar } = require('../src/server');
const { criarArmazenamento } = require('../src/db');

let srv;
let base;

test.before(async () => {
  srv = await iniciar({ porta: 0, store: criarArmazenamento('') });
  base = `http://127.0.0.1:${srv.porta}`;
});

test.after(async () => {
  await srv.encerrar();
});

async function chamar(caminho, opcoes = {}) {
  const res = await fetch(base + caminho, {
    ...opcoes,
    headers: { 'content-type': 'application/json', ...(opcoes.headers || {}) },
  });
  const texto = await res.text();
  return { status: res.status, corpo: texto ? JSON.parse(texto) : null };
}

test('health informa banco e fontes', async () => {
  const { status, corpo } = await chamar('/api/health');
  assert.equal(status, 200);
  assert.equal(corpo.ok, true);
  assert.equal(corpo.banco, 'memoria');
  assert.match(corpo.fontes.shipxy, /demo/);
});

test('chegadas de navios em modo demo', async () => {
  const { status, corpo } = await chamar('/api/navios/chegadas?porto=BRSSZ&dias=7');
  assert.equal(status, 200);
  assert.equal(corpo.fonte, 'demo');
  assert.equal(corpo.total, 3);
  assert.ok(corpo.navios[0].eta <= corpo.navios[1].eta, 'ordenado por ETA');
});

test('janela curta filtra navios', async () => {
  const { corpo } = await chamar('/api/navios/chegadas?porto=BRSSZ&dias=1');
  assert.equal(corpo.total, 1);
});

test('valida porto e dias', async () => {
  assert.equal((await chamar('/api/navios/chegadas?porto=SANTOS')).status, 400);
  assert.equal((await chamar('/api/navios/chegadas?dias=99')).status, 400);
  assert.equal((await chamar('/api/navios/123')).status, 400);
});

test('previsão de entrada liga contêineres aos navios e aponta divergência', async () => {
  const { status, corpo } = await chamar('/api/previsao-entrada?porto=BRSSZ&dias=7');
  assert.equal(status, 200);
  assert.equal(corpo.resumo.totalNavios, 3);
  assert.equal(corpo.resumo.totalConteineresPrevistos, 4);
  const primeiro = corpo.navios.find((n) => n.nome === 'DEMO ATLANTICO');
  assert.equal(primeiro.totalConteineres, 2);
  assert.equal(primeiro.conteineres[0].diferencaHorasParaEtaNavio, 2);
  assert.equal(corpo.resumo.totalDivergencias, 1);
  assert.equal(corpo.divergencias[0].conteiner, 'HLXU8001005');
  assert.equal(corpo.divergencias[0].diferencaHoras, 30);
});

test('cadastro, sincronização, consulta e remoção de contêiner', async () => {
  const novo = await chamar('/api/conteineres', {
    method: 'POST',
    body: JSON.stringify({ numero: 'csqu 305438-3', armador: 'auto', descricao: 'Teste' }),
  });
  assert.equal(novo.status, 201);
  assert.equal(novo.corpo.conteiner.numero, 'CSQU3054383');
  assert.equal(novo.corpo.digitoVerificadorValido, true);
  assert.equal(novo.corpo.sincronizacao.sincronizado, true);
  assert.ok(novo.corpo.sincronizacao.conteiner.etaEtracking);

  const detalhe = await chamar('/api/conteineres/CSQU3054383');
  assert.equal(detalhe.status, 200);
  assert.equal(detalhe.corpo.eventos.length, 2);
  assert.equal(detalhe.corpo.conteiner.rastreioBruto, undefined);

  const sync = await chamar('/api/conteineres/CSQU3054383/sincronizar', { method: 'POST' });
  assert.equal(sync.status, 200);
  assert.equal((await chamar('/api/conteineres/CSQU3054383')).corpo.eventos.length, 2, 'sem duplicar eventos');

  const remover = await fetch(`${base}/api/conteineres/CSQU3054383`, { method: 'DELETE' });
  assert.equal(remover.status, 204);
  assert.equal((await chamar('/api/conteineres/CSQU3054383')).status, 404);
});

test('rejeita contêiner inválido e JSON inválido', async () => {
  const invalido = await chamar('/api/conteineres', { method: 'POST', body: JSON.stringify({ numero: 'ABC123' }) });
  assert.equal(invalido.status, 400);
  const json = await chamar('/api/conteineres', { method: 'POST', body: '{nao-e-json' });
  assert.equal(json.status, 400);
});

test('rastreio avulso não grava nada', async () => {
  const { status, corpo } = await chamar('/api/conteineres/MSCU1234566/rastreio?armador=MSCU');
  assert.equal(status, 200);
  assert.equal(corpo.pronto, true);
  assert.equal(corpo.rastreio.numero, 'MSCU1234566');
});

test('rota inexistente devolve 404 em JSON', async () => {
  const { status, corpo } = await chamar('/api/nada');
  assert.equal(status, 404);
  assert.ok(corpo.erro);
});

test('página de teste é servida', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Portal de Navios/);
});

test('WebSocket envia atualização de navio', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.porta}/ws`);
  const mensagens = [];
  await new Promise((resolve, reject) => {
    ws.on('message', (m) => {
      const msg = JSON.parse(String(m));
      mensagens.push(msg);
      if (msg.tipo === 'bem-vindo') ws.send(JSON.stringify({ acao: 'acompanhar-navio', mmsi: '710000001' }));
      if (msg.tipo === 'atualizacao') resolve();
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('sem atualização')), 5000);
  });
  ws.close();
  const atualizacao = mensagens.find((m) => m.tipo === 'atualizacao');
  assert.equal(atualizacao.dados.nome, 'DEMO ATLANTICO');
});

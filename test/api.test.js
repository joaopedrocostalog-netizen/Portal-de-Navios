'use strict';

// API completa com o DSS simulado (as chamadas ao servidor local passam direto).
process.env.NAVIOS_OF_DSS = 'https://tms.exemplo.com.br/api/v1/portal-navios';
process.env.DSS_USUARIO = 'usuario';
process.env.DSS_SENHA = 'senha';
process.env.DATABASE_URL = '';
process.env.TERMINAL_PADRAO = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { iniciar } = require('../src/server');
const { criarArmazenamento } = require('../src/db');

const fetchOriginal = global.fetch;
const HORA = 3600 * 1000;
const utc = (horas) => new Date(Math.floor(Date.now() / HORA) * HORA + horas * HORA).toISOString().replace('T', ' ').slice(0, 19);

function registro(navio, viagem, horas, extra = {}) {
  return {
    navio, nro_viagem: viagem, armador: 'MSC', terminal: 'btp', timezone: 'UTC',
    data_deadline: utc(horas - 48), data_atracacao: '', data_prev_chegada: utc(horas),
    data_prev_atracacao: utc(horas + 4), data_prev_saida: utc(horas + 30),
    data_prev_abertura_gate: utc(horas - 120), data_abertura_gate: '',
    data_prev_lib_dry: utc(horas + 30), data_lib_dry: '', data_prev_lib_reefer: utc(horas + 26), data_lib_reefer: '',
    ...extra,
  };
}

let respostaDss;
function okDss(registros) {
  return { status: 200, corpo: { status: 200, apiVersion: 1, mensagemErro: '', timezone: 'UTC', qtd_registros: registros.length, registros } };
}

global.fetch = async (url, opcoes) => {
  if (new URL(String(url)).hostname === 'tms.exemplo.com.br') {
    return new Response(JSON.stringify(respostaDss.corpo), { status: respostaDss.status });
  }
  return fetchOriginal(url, opcoes);
};

let srv;
let base;

test.before(async () => {
  respostaDss = okDss([
    registro('MSC INSA', 'NA642R', 20),
    registro('MSC INSA', 'NA650R', 24 * 6), // mesma embarcação, outra viagem
    registro('MAERSK PANGANI', '643N', 50, { terminal: 'outro' }),
    registro('XIAMEN EXPRESS', 'NA641R', -40, { data_atracacao: utc(-12), data_prev_saida: utc(10) }), // atracado agora
    registro('NAVIO QUE JA SAIU', '600N', -200, { data_atracacao: utc(-196), data_prev_saida: utc(-170) }),
    registro('NAVIO DISTANTE', '700N', 24 * 20),
  ]);
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

test('health informa banco e DSS', async () => {
  const { status, corpo } = await chamar('/api/health');
  assert.equal(status, 200);
  assert.equal(corpo.banco, 'memoria');
  assert.equal(corpo.dss, 'configurado');
});

test('atracações do DSS com filtro de terminal e resposta bruta', async () => {
  const todas = await chamar('/api/dss/atracacoes?incluirBruto=true');
  assert.equal(todas.status, 200);
  assert.equal(todas.corpo.total, 6);
  assert.deepEqual(todas.corpo.terminais, ['btp', 'outro']);
  assert.equal(todas.corpo.bruto.qtd_registros, 6);
  const btp = await chamar('/api/dss/atracacoes?terminal=BTP');
  assert.equal(btp.corpo.total, 5);
  assert.equal(btp.corpo.bruto, undefined);
});

test('cadastro exige o navio e normaliza os campos', async () => {
  const semNavio = await chamar('/api/conteineres', { method: 'POST', body: JSON.stringify({ numero: 'MSCU1234566' }) });
  assert.equal(semNavio.status, 400);
  assert.match(semNavio.corpo.erro, /navioNome/);

  const novo = await chamar('/api/conteineres', {
    method: 'POST',
    body: JSON.stringify({ numero: 'mscu 123456-6', armador: 'mscu', navioNome: 'msc insa', navioViagem: 'na642r', perigoso: true }),
  });
  assert.equal(novo.status, 201);
  assert.equal(novo.corpo.conteiner.numero, 'MSCU1234566');
  assert.equal(novo.corpo.conteiner.navioNome, 'MSC INSA');
  assert.equal(novo.corpo.conteiner.navioViagem, 'NA642R');
  assert.equal(novo.corpo.digitoVerificadorValido, true);

  const atualizado = await chamar('/api/conteineres', { method: 'POST', body: JSON.stringify({ numero: 'MSCU1234566', descricao: 'Peças' }) });
  assert.equal(atualizado.status, 200);
  assert.equal(atualizado.corpo.conteiner.navioViagem, 'NA642R', 'mantém o que não foi enviado');

  await chamar('/api/conteineres', { method: 'POST', body: JSON.stringify({ numero: 'CSQU3054383', navioNome: 'Maersk Pangani' }) });
  await chamar('/api/conteineres', { method: 'POST', body: JSON.stringify({ numero: 'MAEU7654320', navioNome: 'NAVIO INEXISTENTE' }) });
  assert.equal((await chamar('/api/conteineres')).corpo.total, 3);
});

test('previsão: janela, atracados, viagem e terminal', async () => {
  const { status, corpo } = await chamar('/api/previsao-entrada?dias=7');
  assert.equal(status, 200);
  assert.equal(corpo.fonte, 'dss');
  assert.deepEqual(
    corpo.navios.map((n) => `${n.navio} ${n.viagem}`),
    ['XIAMEN EXPRESS NA641R', 'MSC INSA NA642R', 'MAERSK PANGANI 643N', 'MSC INSA NA650R'],
    'o que já saiu e o que está fora da janela ficam de fora',
  );
  assert.equal(corpo.resumo.atracados, 1);
  assert.equal(corpo.resumo.previstos, 3);
  const insa = corpo.navios.find((n) => n.viagem === 'NA642R');
  assert.equal(insa.totalConteineres, 1, 'contêiner com viagem só entra na viagem certa');
  assert.equal(insa.conteineres[0].perigoso, true);
  assert.equal(corpo.navios.find((n) => n.viagem === 'NA650R').totalConteineres, 0);
  assert.equal(corpo.navios.find((n) => n.navio === 'MAERSK PANGANI').totalConteineres, 1, 'sem viagem, casa só pelo nome');
  assert.equal(corpo.resumo.totalConteineresPrevistos, 2);
  assert.deepEqual(corpo.semAtracacaoNaJanela.map((c) => c.numero), ['MAEU7654320']);

  const btp = await chamar('/api/previsao-entrada?dias=7&terminal=btp');
  assert.equal(btp.corpo.navios.length, 3);
  assert.equal(btp.corpo.navios.some((n) => n.terminal === 'outro'), false);
});

test('erro do DSS chega ao cliente com a mensagem dele', async () => {
  const anterior = respostaDss;
  respostaDss = { status: 403, corpo: { status: 403, apiVersion: 1, mensagemErro: 'Cliente não está habilitado para utilizar esse endpoint.' } };
  const { status, corpo } = await chamar('/api/previsao-entrada');
  respostaDss = anterior;
  assert.equal(status, 502);
  assert.match(corpo.erro, /não está habilitado/);
});

test('validações', async () => {
  assert.equal((await chamar('/api/previsao-entrada?dias=99')).status, 400);
  assert.equal((await chamar('/api/conteineres', { method: 'POST', body: JSON.stringify({ numero: 'ABC123', navioNome: 'X' }) })).status, 400);
  assert.equal((await chamar('/api/conteineres', { method: 'POST', body: '{nao-e-json' })).status, 400);
  assert.equal((await chamar('/api/nada')).status, 404);
  assert.equal((await chamar('/api/conteineres', { method: 'PUT' })).status, 405);
});

test('remoção de contêiner', async () => {
  const res = await fetch(`${base}/api/conteineres/MAEU7654320`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal((await chamar('/api/conteineres/MAEU7654320')).status, 404);
});

test('página inicial é servida', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Portal de Navios/);
});

test('WebSocket envia a previsão', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.porta}/ws`);
  const atualizacao = await new Promise((resolve, reject) => {
    ws.on('message', (m) => {
      const msg = JSON.parse(String(m));
      if (msg.tipo === 'bem-vindo') ws.send(JSON.stringify({ acao: 'acompanhar-previsao', dias: 7, terminal: 'btp' }));
      if (msg.tipo === 'atualizacao') resolve(msg);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('sem atualização')), 5000);
  });
  ws.close();
  assert.equal(atualizacao.chave, 'previsao:btp:7');
  assert.equal(atualizacao.dados.navios.length, 3);
});

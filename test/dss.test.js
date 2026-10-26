'use strict';

// DSS (Portal de Navios do TMS) com respostas simuladas no formato da documentação,
// cruzado com a Shipxy. Usuário e senha embutidos na URL, como pode estar em NAVIOS_OF_DSS.
process.env.NAVIOS_OF_DSS = 'https://integra%40empresa:s3nh%40@tms.exemplo.com.br/api/v1/portal-navios';
process.env.SHIPXY_API_KEY = 'chave-teste';
process.env.DATABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const dss = require('../src/services/dss');
const { iniciar } = require('../src/server');
const { criarArmazenamento } = require('../src/db');

const fetchOriginal = global.fetch;
const HORA = 3600 * 1000;
const utc = (horas) => new Date(Math.floor(Date.now() / HORA) * HORA + horas * HORA).toISOString().replace('T', ' ').slice(0, 19);

let respostaDss;
let respostaShipxy;
let ultimaDss;

global.fetch = async (url, opcoes = {}) => {
  const alvo = new URL(String(url));
  if (alvo.hostname === 'tms.exemplo.com.br') {
    ultimaDss = { url: String(url), cabecalhos: opcoes.headers };
    return new Response(JSON.stringify(respostaDss.corpo), { status: respostaDss.status });
  }
  if (alvo.hostname === 'api.shipxy.com') {
    return new Response(JSON.stringify(respostaShipxy), { status: 200 });
  }
  return fetchOriginal(url, opcoes);
};

function registro(navio, horas, extra = {}) {
  return {
    navio,
    nro_viagem: '123S',
    armador: 'MSC',
    terminal: 'btp',
    timezone: 'UTC',
    data_deadline: utc(horas - 48),
    data_atracacao: '',
    data_prev_chegada: utc(horas),
    data_prev_atracacao: utc(horas + 4),
    data_prev_saida: utc(horas + 30),
    data_prev_abertura_gate: utc(horas - 120),
    data_abertura_gate: '',
    data_prev_lib_dry: utc(horas + 30),
    data_lib_dry: '',
    data_prev_lib_reefer: utc(horas + 26),
    data_lib_reefer: '',
    ...extra,
  };
}

function okDss(registros) {
  return { status: 200, corpo: { status: 200, apiVersion: 1, mensagemErro: '', timezone: 'UTC', qtd_registros: registros.length, registros } };
}

let srv;
let base;

test.before(async () => {
  respostaDss = okDss([]);
  respostaShipxy = { status: 0, data: [] };
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

test('datas do DSS em UTC viram ISO 8601', () => {
  assert.equal(dss.dataUtc('2024-07-20 18:00:00'), '2024-07-20T18:00:00.000Z');
  assert.equal(dss.dataUtc('2024-07-20 18:00'), '2024-07-20T18:00:00.000Z');
  assert.equal(dss.dataUtc(''), null);
  assert.equal(dss.dataUtc('string'), null);
  assert.equal(dss.dataUtc(null), null);
});

test('usuário e senha da URL viram Basic Auth e saem da URL', async () => {
  respostaDss = okDss([registro('MSC ANNA', 20)]);
  const r = await dss.atracacoes();
  assert.equal(ultimaDss.url, 'https://tms.exemplo.com.br/api/v1/portal-navios');
  const esperado = `Basic ${Buffer.from('integra@empresa:s3nh@').toString('base64')}`;
  assert.equal(ultimaDss.cabecalhos.authorization, esperado);
  assert.equal(r.dados[0].navio, 'MSC ANNA');
  assert.equal(r.dados[0].situacao, 'previsto');
  assert.equal(r.dados[0].datas.atracacao, null);
  assert.match(r.dados[0].datas.prevLiberacaoReefer, /Z$/);
});

test('erros 401, 403 e 500 do DSS chegam com a mensagem dele', async () => {
  respostaDss = { status: 401, corpo: { status: 401, apiVersion: 1, mensagemErro: 'Usuário ou senha inválidos' } };
  await assert.rejects(dss.atracacoes(), /Usuário ou senha inválidos.*DSS_USUARIO/);
  respostaDss = { status: 403, corpo: { status: 403, apiVersion: 1, mensagemErro: 'Instale o módulo tms_integr_portal_navios para utilizar.' } };
  await assert.rejects(dss.atracacoes(), /tms_integr_portal_navios/);
  respostaDss = { status: 500, corpo: { status: 500, apiVersion: 1, mensagemErro: 'Erro ao acessar o sistema TMS' } };
  await assert.rejects(dss.atracacoes(), /HTTP 500: Erro ao acessar o sistema TMS/);
});

test('previsão: DSS é a lista principal, cruzada com o AIS pelo nome', async () => {
  respostaDss = okDss([
    registro('MSC ANNA', 20),
    registro('Maersk Essen', 60), // AIS diverge 40 h
    registro('NAVIO ATRACADO', -10, { data_atracacao: utc(-6) }),
    registro('NAVIO ANTIGO', -200, { data_atracacao: utc(-196), data_prev_saida: utc(-170) }),
    registro('NAVIO DISTANTE', 24 * 20),
  ]);
  respostaShipxy = {
    status: 0,
    data: [
      { mmsi: 111111111, imo: 9111111, ship_name: 'MSC ANNA', eta_utc: Math.floor((Date.now() + 21 * HORA) / 1000) },
      { mmsi: 222222222, imo: 9222222, ship_name: 'MAERSK ESSEN', eta_utc: Math.floor((Date.now() + 100 * HORA) / 1000) },
      { mmsi: 333333333, imo: 9333333, ship_name: 'OUTRO TERMINAL', eta_utc: Math.floor((Date.now() + 50 * HORA) / 1000) },
    ],
  };
  await chamar('/api/conteineres', {
    method: 'POST',
    body: JSON.stringify({ numero: 'MSCU1234566', navioNome: 'msc anna' }),
  });
  await chamar('/api/conteineres', {
    method: 'POST',
    body: JSON.stringify({ numero: 'CSQU3054383', navioMmsi: '333333333' }),
  });

  const { status, corpo } = await chamar('/api/previsao-entrada?porto=BRSSZ&dias=7');
  assert.equal(status, 200);
  assert.deepEqual(corpo.fontes, { atracacoes: 'dss', ais: 'shipxy' });
  assert.deepEqual(
    corpo.navios.map((n) => n.nome),
    ['NAVIO ATRACADO', 'MSC ANNA', 'Maersk Essen'],
    'atracado agora entra; já saiu e muito distante ficam de fora',
  );
  const anna = corpo.navios.find((n) => n.nome === 'MSC ANNA');
  assert.equal(anna.mmsi, '111111111');
  assert.equal(anna.terminal, 'btp');
  assert.equal(anna.totalConteineres, 1);
  assert.ok(anna.datas.deadline);
  assert.equal(corpo.navios[0].situacao, 'atracado');

  assert.equal(corpo.divergencias.length, 1);
  assert.equal(corpo.divergencias[0].tipo, 'chegada-dss-x-ais');
  assert.equal(corpo.divergencias[0].navio, 'Maersk Essen');

  assert.equal(corpo.naviosSomenteAis.length, 1);
  assert.equal(corpo.naviosSomenteAis[0].nome, 'OUTRO TERMINAL');
  assert.equal(corpo.naviosSomenteAis[0].totalConteineres, 1);
  assert.equal(corpo.resumo.totalConteineresPrevistos, 2);
});

test('se a Shipxy recusar a chave, a previsão segue só com o DSS e avisa', async () => {
  respostaShipxy = { status: 9, msg: 'Key不存在' };
  const { status, corpo } = await chamar('/api/previsao-entrada?porto=BRSSZ&dias=7');
  assert.equal(status, 200);
  assert.equal(corpo.fontes.ais, 'erro');
  assert.equal(corpo.navios.length, 3);
  assert.equal(corpo.avisos[0].fonte, 'shipxy');
  assert.match(corpo.avisos[0].mensagem, /Key不存在/);
});

test('se as duas fontes falharem, devolve 502 com os avisos', async () => {
  respostaDss = { status: 500, corpo: { status: 500, apiVersion: 1, mensagemErro: 'Erro ao acessar o sistema TMS' } };
  const { status, corpo } = await chamar('/api/previsao-entrada');
  assert.equal(status, 502);
  assert.equal(corpo.detalhes.length, 2);
});

test('/api/dss/atracacoes expõe a resposta bruta para conferência', async () => {
  respostaDss = okDss([registro('MSC ANNA', 20)]);
  const { corpo } = await chamar('/api/dss/atracacoes?incluirBruto=true');
  assert.equal(corpo.fonte, 'dss');
  assert.equal(corpo.bruto.registros[0].nro_viagem, '123S');
  const health = await chamar('/api/health');
  assert.equal(health.corpo.fontes.dss, 'configurado');
});

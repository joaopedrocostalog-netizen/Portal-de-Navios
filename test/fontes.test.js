'use strict';

// Testa a leitura das respostas reais da Shipxy simulando o fetch,
// sem gastar créditos nem precisar de rede.
process.env.SHIPXY_API_KEY = 'chave-shipxy-teste';

const test = require('node:test');
const assert = require('node:assert/strict');
const shipxy = require('../src/services/shipxy');
const etracking = require('../src/services/etracking');
const { digitoVerificadorValido, paraIso } = require('../src/util');

const fetchOriginal = global.fetch;
let ultimaUrl;

function simular(status, corpo) {
  global.fetch = async (url) => {
    ultimaUrl = String(url);
    return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
  };
}

test.after(() => {
  global.fetch = fetchOriginal;
});

test('dígito verificador ISO 6346', () => {
  assert.equal(digitoVerificadorValido('CSQU3054383'), true);
  assert.equal(digitoVerificadorValido('CSQU3054384'), false);
  assert.equal(digitoVerificadorValido('MSCU1234566'), true);
});

test('paraIso aceita Unix em segundos, milissegundos e texto', () => {
  assert.equal(paraIso(1746612218), '2025-05-07T10:03:38.000Z');
  assert.equal(paraIso('1746612218000'), '2025-05-07T10:03:38.000Z');
  assert.equal(paraIso('2026-10-28 14:30:00Z'), '2026-10-28T14:30:00.000Z');
  assert.equal(paraIso(null), null);
});

test('Shipxy GetETAShips: monta a URL certa e normaliza os navios', async () => {
  simular(200, {
    status: 0,
    msg: 'ok',
    total: 2,
    data: [
      { mmsi: 2, ship_name: 'NAVIO B', imo: 22, eta_utc: 1793000000, dest: 'SANTOS', ship_flag: 'PA' },
      { mmsi: 1, ship_name: 'NAVIO A', imo: 11, eta_utc: 1792000000, dest: 'SANTOS', ship_flag: 'BR', draught: 12.1 },
    ],
  });
  const inicio = new Date('2026-10-26T00:00:00Z');
  const fim = new Date('2026-11-02T00:00:00Z');
  const r = await shipxy.chegadasPrevistas('BRSSZ', inicio, fim);
  const url = new URL(ultimaUrl);
  assert.equal(url.pathname, '/apicall/v3/GetETAShips');
  assert.equal(url.searchParams.get('key'), 'chave-shipxy-teste');
  assert.equal(url.searchParams.get('port_code'), 'BRSSZ');
  assert.equal(url.searchParams.get('start_time'), String(inicio.getTime() / 1000));
  assert.equal(r.fonte, 'shipxy');
  assert.deepEqual(r.dados.map((n) => n.nome), ['NAVIO A', 'NAVIO B']);
  assert.equal(r.dados[0].mmsi, '1');
  assert.equal(r.dados[0].calado, 12.1);
});

test('Shipxy com status diferente de 0 vira erro claro', async () => {
  simular(200, { status: 14, msg: 'sem permissão' });
  await assert.rejects(shipxy.chegadasPrevistas('BRSSZ', new Date(), new Date()), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /sem permissão/);
    return true;
  });
});

test('Shipxy GetSingleShip normaliza posição', async () => {
  simular(200, { status: 0, data: { mmsi: 710000001, ship_name: 'X', lat: -23.9, lng: -46.3, sog: 12, last_time_utc: 1792000000 } });
  const r = await shipxy.buscarNavio('710000001');
  assert.match(ultimaUrl, /GetSingleShip\?key=.*mmsi=710000001/);
  assert.deepEqual(r.dados.posicao, { lat: -23.9, lon: -46.3, velocidade: 12, rumo: null, atualizadoEm: paraIso(1792000000) });
});

test('Shipxy SearchPort normaliza os portos', async () => {
  simular(200, {
    status: 0,
    msg: 'ok',
    total: 1,
    data: [{ port_code: 'CNQDG', port_name: 'Qingdao', port_cnname: '青岛', port_time_zone: '+8', port_country_name: 'China', port_country_code: 'CN' }],
  });
  const r = await shipxy.buscarPortos('qingdao', 6);
  const url = new URL(ultimaUrl);
  assert.equal(url.pathname, '/apicall/v3/SearchPort');
  assert.equal(url.searchParams.get('keywords'), 'qingdao');
  assert.equal(url.searchParams.get('max'), '6');
  assert.deepEqual(r.dados[0], { codigo: 'CNQDG', nome: 'Qingdao', nomeChines: '青岛', pais: 'China', codigoPais: 'CN', fusoHorario: '+8' });
});

test('sem fonte de eTracking, a consulta devolve 501 com orientação', async () => {
  assert.equal(etracking.configurada(), false);
  assert.equal(etracking.disponivel(), false);
  await assert.rejects(etracking.rastrear('MSCU1234566'), (e) => {
    assert.equal(e.status, 501);
    assert.match(e.message, /Informe o navio/);
    return true;
  });
});

test('mensagens de erro de rede nunca expõem a chave', async () => {
  global.fetch = async () => {
    throw new Error('boom');
  };
  await assert.rejects(shipxy.buscarNavio('710000001'), (e) => {
    assert.doesNotMatch(e.message, /chave-shipxy-teste/);
    return true;
  });
});

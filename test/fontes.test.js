'use strict';

// Testa a leitura das respostas reais das APIs (Shipxy e VesselFinder) simulando o fetch,
// sem gastar créditos nem precisar de rede.
process.env.SHIPXY_API_KEY = 'chave-shipxy-teste';
process.env.VESSELFINDER_API_KEY = 'chave-vf-teste';

const test = require('node:test');
const assert = require('node:assert/strict');
const shipxy = require('../src/services/shipxy');
const vesselfinder = require('../src/services/vesselfinder');
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

test('VesselFinder 200: normaliza e calcula ETA de destino', async () => {
  simular(200, {
    status: 'success',
    general: { origin: 'Shanghai CNSHA', destination: 'Santos BRSSZ', progress: 65, currentLocation: 'At sea', carrier: 'MSC', sealine: 'MSCU' },
    schedule: [
      { port: 'Shanghai', locode: 'CNSHA', event: 'Loaded', timestamp: '2026-10-01T10:00:00Z', actual: true, vessel: 'MSC ANNA' },
      { port: 'Santos', locode: 'BRSSZ', event: 'Discharge', timestamp: '2026-10-30T08:00:00Z', actual: false, vessel: 'MSC ANNA' },
      { port: 'Santos', locode: 'BRSSZ', event: 'Gate out', timestamp: '2026-11-02T08:00:00Z', actual: false },
    ],
    vessel: { name: 'MSC ANNA', imo: 9000001, mmsi: 710000001, latitude: -10, longitude: -30, speed: 15, course: 200 },
  });
  const r = await vesselfinder.rastrear('MSCU1234566', 'MSCU');
  assert.ok(ultimaUrl.endsWith('/container/chave-vf-teste/MSCU1234566/MSCU'));
  assert.equal(r.pronto, true);
  assert.equal(r.dados.locodeDestino, 'BRSSZ');
  assert.equal(r.dados.etaDestino, '2026-11-02T08:00:00.000Z');
  assert.equal(r.dados.navio.mmsi, '710000001');
  assert.equal(r.dados.eventos.length, 3);
});

test('VesselFinder 202: devolve "na fila" com tempo de espera mínimo de 60 s', async () => {
  simular(202, { status: 'queued', retryAfter: 30 });
  const r = await vesselfinder.rastrear('MSCU1234566', 'AUTO');
  assert.equal(r.pronto, false);
  assert.equal(r.situacao, 'queued');
  assert.equal(r.tenteNovamenteEmSegundos, 60);
});

test('VesselFinder 401 e 409 viram mensagens em português', async () => {
  simular(401, { status: 'error' });
  await assert.rejects(vesselfinder.rastrear('MSCU1234566'), /VESSELFINDER_API_KEY inválida/);
  simular(409, { status: 'error', code: 'CARRIER', message: 'not found' });
  await assert.rejects(vesselfinder.rastrear('MSCU1234566'), (e) => e.status === 409);
});

test('mensagens de erro nunca expõem a chave', async () => {
  global.fetch = async () => {
    throw new Error('boom');
  };
  await assert.rejects(vesselfinder.rastrear('MSCU1234566'), (e) => {
    assert.doesNotMatch(e.message, /chave-vf-teste/);
    return true;
  });
});

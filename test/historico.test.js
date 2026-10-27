'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarMemoria, compararEstados, chaveDe, iniciarHistorico, rotuloCampo } = require('../src/historico');
const { criarCliente } = require('../src/dss');
const { criarServidor } = require('../src/server');

const reg = (navio, viagem, terminal, datas = {}, armador = 'MSC') => ({ navio, nro_viagem: viagem, armador, terminal, timezone: 'UTC', ...datas });
const INSA = reg('MSC INSA', 'NA642R', 'btp', { data_prev_chegada: '2026-10-24 10:00:00', data_deadline: '2026-10-25 15:00:00' });
const PERLE = reg('MSC PERLE', 'UX641R', 'santos_brasil', { data_prev_chegada: '2026-10-28 08:00:00' });
const T0 = Date.parse('2026-10-26T12:00:00Z');

test('chave ignora pontuação e caixa', () => {
  assert.equal(chaveDe(INSA), 'btp|MSCINSA|NA642R');
  assert.equal(chaveDe({ terminal: 'BTP ', navio: 'msc  insa', viagem: 'na-642r' }), 'btp|MSCINSA|NA642R');
});

test('compara campo a campo', () => {
  const anterior = new Map([[chaveDe(INSA), INSA]]);
  const novo = { ...INSA, data_deadline: '2026-10-26 11:00:00', data_abertura_gate: '2026-10-23 10:00:00' };
  const { mudancas } = compararEstados(anterior, [novo, PERLE], 'x');
  assert.deepEqual(
    mudancas.map((m) => [m.navio, m.campo, m.de, m.para]),
    [
      ['MSC INSA', 'data_abertura_gate', null, '2026-10-23 10:00:00'],
      ['MSC INSA', 'data_deadline', '2026-10-25 15:00:00', '2026-10-26 11:00:00'],
      ['MSC PERLE', 'registro', null, 'novo'],
    ],
  );
});

test('primeira consulta é só a base; depois registra mudanças, saídas e voltas', async () => {
  const h = criarMemoria();
  await h.iniciar();
  assert.deepEqual(await h.registrar([INSA, PERLE], T0), [], 'sem estado anterior não há mudança');
  assert.deepEqual(await h.registrar([INSA, PERLE], T0 + 60e3), [], 'nada mudou');

  const adiado = { ...INSA, data_deadline: '2026-10-26 11:00:00' };
  const m1 = await h.registrar([adiado], T0 + 120e3);
  assert.deepEqual(m1.map((m) => `${m.navio}:${m.campo}:${m.para}`), ['MSC INSA:data_deadline:2026-10-26 11:00:00', 'MSC PERLE:registro:removido']);

  const m2 = await h.registrar([adiado, PERLE], T0 + 180e3);
  assert.deepEqual(m2.map((m) => `${m.navio}:${m.campo}:${m.para}`), ['MSC PERLE:registro:voltou']);

  const lista = await h.listar({ navio: 'insa' });
  assert.equal(lista.length, 1);
  assert.equal(lista[0].de, '2026-10-25 15:00:00');
  assert.deepEqual(h.contarPorChave(new Date(T0).toISOString()), { 'btp|MSCINSA|NA642R': 1 }, '"registro" não conta como data mudada');
});

test('rótulo usa a leitura corrigida do terminal', () => {
  assert.equal(rotuloCampo('data_lib_reefer', 'btp'), 'Abertura do gate reefer');
  assert.equal(rotuloCampo('data_lib_reefer', 'embraport'), 'Liberação reefer');
  assert.equal(rotuloCampo('data_deadline', 'btp'), 'Deadline');
});

test('sem DATABASE_URL usa memória', async () => {
  const logs = [];
  const h = await iniciarHistorico('', {}, (l) => logs.push(l));
  assert.equal(h.tipo, 'memoria');
  assert.match(logs[0], /memória/);
});

test('banco fora do ar cai para memória', async () => {
  const logs = [];
  const h = await iniciarHistorico('postgres://u:s@127.0.0.1:1/x', {}, (l) => logs.push(l));
  assert.equal(h.tipo, 'memoria');
});

test('rotas /api/painel, /api/mudancas e /api/navio', async () => {
  let corpo = [INSA, PERLE];
  const f = async () => new Response(JSON.stringify({ status: 200, apiVersion: 1, timezone: 'UTC', qtd_registros: corpo.length, registros: corpo }), { status: 200 });
  const h = criarMemoria();
  await h.iniciar();
  const c = criarCliente({ url: 'https://dss.exemplo.com/x', fetch: f, intervaloMinimoForcarMs: 0, aoAtualizar: (r, em) => h.registrar(r, em) });
  const srv = criarServidor(c, h);
  await new Promise((r) => srv.listen(0, r));
  const get = async (p) => (await fetch(`http://127.0.0.1:${srv.address().port}${p}`)).json();

  await get('/api/navios?atualizar=true');
  corpo = [{ ...INSA, data_deadline: '2026-10-26 11:00:00' }, PERLE];
  await get('/api/navios?atualizar=true');
  await new Promise((r) => setTimeout(r, 20)); // o gancho do histórico roda depois da resposta

  const painel = await get('/api/painel?dias=tudo&encerrados=true');
  assert.equal(painel.historico, 'memoria');
  assert.equal(painel.mudancas.length, 1);
  assert.equal(painel.mudancas[0].rotulo, 'Deadline');
  assert.equal(painel.navios.find((n) => n.navio === 'MSC INSA').mudancas24h, 1);
  assert.equal(painel.navios.find((n) => n.navio === 'MSC PERLE').mudancas24h, undefined);

  const filtrado = await get('/api/painel?dias=tudo&encerrados=true&terminal=santos_brasil');
  assert.equal(filtrado.mudancas.length, 0, 'mudanças seguem o filtro do painel');

  const m = await get('/api/mudancas?horas=48&campo=data_deadline');
  assert.equal(m.total, 1);

  const d = await get(`/api/navio?chave=${encodeURIComponent('btp|MSCINSA|NA642R')}`);
  assert.equal(d.navio.navio, 'MSC INSA');
  assert.equal(d.navio.datas.deadline, '2026-10-26T11:00:00.000Z');
  assert.equal(d.mudancas.length, 1);
  assert.equal((await fetch(`http://127.0.0.1:${srv.address().port}/api/navio?chave=x`)).status, 404);
  srv.close();
});

// Teste com PostgreSQL real: PG_TESTE_URL=postgres://... npm test
test('PostgreSQL guarda estado e mudanças entre reinícios', { skip: !process.env.PG_TESTE_URL }, async () => {
  const url = process.env.PG_TESTE_URL;
  const a = await iniciarHistorico(url, {}, () => {});
  assert.equal(a.tipo, 'postgres');
  await a.registrar([INSA, PERLE], T0);
  await a.registrar([{ ...INSA, data_deadline: '2026-10-26 11:00:00' }, PERLE], T0 + 60e3);
  await a.encerrar();

  const b = await iniciarHistorico(url, {}, () => {});
  const doBanco = await b.listar({ chave: 'btp|MSCINSA|NA642R' });
  assert.deepEqual(doBanco.map((m) => [m.campo, m.de, m.para]), [['data_deadline', '2026-10-25 15:00:00', '2026-10-26 11:00:00']]);
  // Depois do reinício a comparação continua de onde parou (não recria a base).
  const m = await b.registrar([{ ...INSA, data_deadline: '2026-10-26 11:00:00' }], T0 + 120e3);
  assert.deepEqual(m.map((x) => `${x.navio}:${x.para}`), ['MSC PERLE:removido']);
  await b.encerrar();
});

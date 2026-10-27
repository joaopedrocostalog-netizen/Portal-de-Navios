'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarCliente, normalizar, filtrar, resumir, dataUtc } = require('../src/dss');
const { criarServidor } = require('../src/server');

const H = 3600e3;
const AGORA = Date.parse('2026-10-27T15:00:00Z');
const utc = (horas) => new Date(AGORA + horas * H).toISOString().replace('T', ' ').slice(0, 19);

// Registro no formato exato da API (todos os campos), com datas relativas a AGORA.
function registro(navio, viagem, terminal, d = {}, extra = {}) {
  const campos = {
    data_deadline: '', data_atracacao: '', data_prev_chegada: '', data_prev_atracacao: '', data_prev_saida: '',
    data_prev_abertura_gate: '', data_abertura_gate: '', data_prev_lib_dry: '', data_lib_dry: '', data_prev_lib_reefer: '', data_lib_reefer: '',
  };
  for (const [k, v] of Object.entries(d)) campos[`data_${k}`] = v === null ? '' : utc(v);
  return { navio, nro_viagem: viagem, armador: extra.armador || 'MSC', terminal, timezone: 'UTC', ...campos };
}

const REGISTROS = [
  // previsto, gate aberto (abertura real), deadline em 20 h
  registro('MSC INSA', 'NA642R', 'btp', { prev_chegada: -100, prev_atracacao: 30, prev_saida: 55, prev_abertura_gate: -80, abertura_gate: -78, deadline: 20, prev_lib_dry: 60, prev_lib_reefer: 56 }),
  // atracação atrasada (prevista há 5 h, não atracou), gate encerrado
  registro('XIAMEN EXPRESS', 'NA641R', 'btp', { prev_chegada: -150, prev_atracacao: -5, prev_saida: 20, prev_abertura_gate: -200, deadline: -60 }, { armador: 'HLC' }),
  // atracado (2 h depois do previsto), liberação dry feita, reefer atrasada
  registro('MAERSK LOTA', '644N', 'santos_brasil', { prev_chegada: -40, prev_atracacao: -20, atracacao: -18, prev_saida: 10, deadline: -50, prev_lib_dry: -8, lib_dry: -7, prev_lib_reefer: -6 }, { armador: 'MAE' }),
  // encerrado (atracou e a saída prevista já passou)
  registro('MSC GIULIA', 'QI642R', 'embraport', { prev_atracacao: -60, atracacao: -58, prev_saida: -2, deadline: -90 }),
  // previsto distante, gate aguardando abertura em 30 h
  registro('COPIAPO', 'MM643R', 'btp', { prev_chegada: 40, prev_atracacao: 46, prev_saida: 70, prev_abertura_gate: 30, deadline: 44 }, { armador: 'HLC' }),
  // sem datas de gate
  registro('NAVIO SEM GATE', '1A', 'embraport', { prev_atracacao: 200 }),
];

const ok = (registros = REGISTROS) => ({ status: 200, apiVersion: 1, mensagemErro: '', timezone: 'UTC', qtd_registros: registros.length, registros });

test('datas UTC do DSS', () => {
  assert.equal(dataUtc('2024-07-20 18:00:00'), '2024-07-20T18:00:00.000Z');
  assert.equal(dataUtc('2024-07-20 18:00'), '2024-07-20T18:00:00.000Z');
  assert.equal(dataUtc(''), null);
  assert.equal(dataUtc('string'), null);
});

test('usa todos os campos e calcula as situações', () => {
  const [insa, xiamen, lota, giulia, copiapo, semGate] = REGISTROS.map((r) => normalizar(r, AGORA));
  assert.deepEqual(Object.keys(insa.datas).length, 11);
  assert.equal(insa.terminal, 'btp');
  assert.equal(insa.viagem, 'NA642R');
  assert.deepEqual(insa.situacao, { navio: 'previsto', gate: 'aberto', dry: 'previsto', reefer: 'previsto' });
  assert.equal(insa.horas.ateDeadline, 20);
  assert.equal(insa.horas.atrasoAberturaGate, 2);
  assert.equal(insa.horas.janelaGate, 98, 'da abertura real ao deadline');
  assert.equal(insa.horas.estadia, 25);

  assert.deepEqual(xiamen.situacao, { navio: 'atracacao_atrasada', gate: 'encerrado', dry: 'sem_dado', reefer: 'sem_dado' });
  assert.equal(xiamen.horas.ateDeadline, null);

  assert.deepEqual(lota.situacao, { navio: 'atracado', gate: 'encerrado', dry: 'liberado', reefer: 'atrasado' });
  assert.equal(lota.horas.atrasoAtracacao, 2);
  assert.equal(lota.horas.atrasoLiberacaoDry, 1);

  assert.equal(giulia.situacao.navio, 'encerrado');
  assert.equal(copiapo.situacao.gate, 'aguardando');
  assert.equal(semGate.situacao.gate, 'sem_dado');
  assert.equal(copiapo.referencia, copiapo.datas.prevAtracacao);
});

test('filtros por terminal, armador, navio, viagem, situação, gate e período', () => {
  const todos = REGISTROS.map((r) => normalizar(r, AGORA));
  const nomes = (q) => filtrar(todos, q).map((r) => r.navio);
  assert.deepEqual(nomes({ terminal: 'btp' }), ['MSC INSA', 'XIAMEN EXPRESS', 'COPIAPO']);
  assert.deepEqual(nomes({ terminal: 'santos_brasil,embraport' }), ['MAERSK LOTA', 'MSC GIULIA', 'NAVIO SEM GATE']);
  assert.deepEqual(nomes({ armador: 'hlc' }), ['XIAMEN EXPRESS', 'COPIAPO']);
  assert.deepEqual(nomes({ navio: 'msc' }), ['MSC INSA', 'MSC GIULIA']);
  assert.deepEqual(nomes({ viagem: 'na641r' }), ['XIAMEN EXPRESS']);
  assert.deepEqual(nomes({ situacao: 'atracado,encerrado' }), ['MAERSK LOTA', 'MSC GIULIA']);
  assert.deepEqual(nomes({ gate: 'aberto' }), ['MSC INSA']);
  assert.deepEqual(nomes({ de: new Date(AGORA).toISOString(), ate: new Date(AGORA + 72 * H).toISOString() }), ['MSC INSA', 'COPIAPO']);
});

test('resumo das próximas horas', () => {
  const r = resumir(REGISTROS.map((x) => normalizar(x, AGORA)), { horas: 48, agora: AGORA });
  assert.equal(r.total, 6);
  assert.deepEqual(r.porTerminal, { btp: 3, santos_brasil: 1, embraport: 2 });
  assert.deepEqual(r.porSituacao, { previsto: 3, atracacao_atrasada: 1, atracado: 1, encerrado: 1 });
  assert.deepEqual(r.porGate, { aberto: 1, encerrado: 3, aguardando: 1, sem_dado: 1 });
  assert.deepEqual(r.deadlines.map((x) => [x.navio, x.horasRestantes]), [['MSC INSA', 20]]);
  assert.deepEqual(r.aberturasGate.map((x) => x.navio), ['COPIAPO']);
  assert.deepEqual(r.chegadas.map((x) => x.navio), ['COPIAPO']);
  assert.deepEqual(r.atracacoes.map((x) => x.navio), ['MSC INSA', 'COPIAPO']);
  assert.deepEqual(r.liberacoes, [], 'liberações de MSC INSA são em 56 h e 60 h');
  assert.deepEqual(r.atrasados.map((x) => x.navio), ['XIAMEN EXPRESS', 'MAERSK LOTA']);
  assert.deepEqual(resumir(REGISTROS.map((x) => normalizar(x, AGORA)), { horas: 72, agora: AGORA }).liberacoes.map((x) => x.tipo), ['reefer', 'dry']);
});

// ------------------------------------------------------------------ cliente HTTP
function fetchFalso(respostas) {
  const chamadas = [];
  const f = async (url, opcoes) => {
    chamadas.push({ url: String(url), auth: opcoes.headers.authorization });
    const r = respostas.length > 1 ? respostas.shift() : respostas[0];
    if (r instanceof Error) throw r;
    return new Response(typeof r.corpo === 'string' ? r.corpo : JSON.stringify(r.corpo), { status: r.status });
  };
  f.chamadas = chamadas;
  return f;
}

test('Basic Auth (inclusive embutido na URL), cache e consulta compartilhada', async () => {
  const f = fetchFalso([{ status: 200, corpo: ok() }]);
  const c = criarCliente({ url: 'https://us%40r:s3nh%40@dss.exemplo.com/wsdss/navios/listarNavios', fetch: f, cacheSegundos: 60 });
  const [a] = await Promise.all([c.listar(), c.listar()]);
  await c.listar();
  assert.equal(f.chamadas.length, 1, 'pedidos simultâneos e em cache não repetem a consulta');
  assert.equal(f.chamadas[0].url, 'https://dss.exemplo.com/wsdss/navios/listarNavios');
  assert.equal(f.chamadas[0].auth, `Basic ${Buffer.from('us@r:s3nh@').toString('base64')}`);
  assert.equal(a.qtdRegistros, 6);
  assert.equal(a.apiVersion, 1);
  await c.listar({ forcar: true });
  assert.equal(f.chamadas.length, 2);
});

test('erros 400, 401, 403, 500, HTML e rede', async () => {
  const casos = [
    [{ status: 400, corpo: { status: 400, apiVersion: 1, mensagemErro: 'CAMPOS OBRIGATÓRIOS NÃO INFORMADOS: data_inicio' } }, /requisição recusada – CAMPOS OBRIGATÓRIOS/],
    [{ status: 401, corpo: { status: 401, apiVersion: 1, mensagemErro: 'Usuário ou senha inválidos' } }, /DSS_USUARIO/],
    [{ status: 403, corpo: { status: 403, apiVersion: 1, mensagemErro: 'Instale o módulo tms_integr_portal_navios para utilizar.' } }, /módulo tms_integr_portal_navios habilitado/],
    [{ status: 500, corpo: { status: 500, apiVersion: 1, mensagemErro: 'Erro ao acessar o sistema TMS' } }, /erro no TMS – Erro ao acessar o sistema TMS/],
    [{ status: 200, corpo: '<!DOCTYPE html><title>APIs DSS</title>' }, /não é JSON \(confira DSS_URL\)/],
    [new TypeError('fetch failed'), /DSS inacessível/],
  ];
  for (const [resposta, erro] of casos) {
    const c = criarCliente({ url: 'https://dss.exemplo.com/x', usuario: 'u', senha: 's', fetch: fetchFalso([resposta]) });
    await assert.rejects(c.listar(), erro);
  }
});

test('se o DSS falhar depois, devolve a última consulta boa com aviso', async () => {
  const f = fetchFalso([{ status: 200, corpo: ok() }, { status: 500, corpo: { status: 500, mensagemErro: 'Erro ao acessar o sistema TMS' } }]);
  const c = criarCliente({ url: 'https://dss.exemplo.com/x', fetch: f, cacheSegundos: 60 });
  await c.listar();
  const r = await c.listar({ forcar: true });
  assert.equal(r.registros.length, 6);
  assert.match(r.aviso, /erro no TMS.*última consulta/);
});

// ------------------------------------------------------------------ servidor
test('rotas do servidor', async () => {
  const f = fetchFalso([{ status: 200, corpo: ok() }]);
  const srv = criarServidor(criarCliente({ url: 'https://dss.exemplo.com/x', fetch: f }));
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    const tipo = res.headers.get('content-type');
    return { status: res.status, corpo: tipo.includes('json') ? await res.json() : await res.text() };
  };
  try {
    assert.equal((await get('/api/health')).corpo.dss, 'configurado');
    const navios = await get('/api/navios?terminal=btp&ordenar=deadline');
    assert.equal(navios.corpo.total, 3);
    assert.equal(navios.corpo.qtdRegistrosDss, 6);
    assert.deepEqual(navios.corpo.terminais, ['btp', 'embraport', 'santos_brasil']);
    assert.deepEqual(navios.corpo.armadores, ['HLC', 'MAE', 'MSC']);
    const resumo = await get('/api/resumo?horas=72');
    assert.equal(resumo.corpo.proximasHoras, 72);
    assert.equal(resumo.corpo.total, 6);
    const bruto = await get('/api/dss/bruto');
    assert.equal(bruto.corpo.registros[0].nro_viagem, 'NA642R');
    assert.match((await get('/')).corpo, /Portal de Navios/);
    assert.equal((await get('/api/nada')).status, 404);
    assert.equal((await fetch(`${base}/api/navios`, { method: 'POST' })).status, 405);
  } finally {
    srv.close();
  }

  const semDss = criarServidor(null);
  await new Promise((r) => semDss.listen(0, r));
  const r = await fetch(`http://127.0.0.1:${semDss.address().port}/api/navios`);
  assert.equal(r.status, 503);
  semDss.close();
});

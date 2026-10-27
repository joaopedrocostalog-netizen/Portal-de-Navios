'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarCliente, normalizar, normalizarTodos, filtrar, resumir, dataUtc } = require('../src/dss');
const { criarServidor } = require('../src/server');

const H = 3600e3;
const AGORA = Date.parse('2026-10-27T15:00:00Z');
const utc = (horas) => new Date(AGORA + horas * H).toISOString().replace('T', ' ').slice(0, 19);

// Registro no formato exato da API, com datas relativas a AGORA (em horas).
function registro(navio, viagem, terminal, d = {}, armador = 'MSC') {
  const campos = {
    data_deadline: '', data_atracacao: '', data_prev_chegada: '', data_prev_atracacao: '', data_prev_saida: '',
    data_prev_abertura_gate: '', data_abertura_gate: '', data_prev_lib_dry: '', data_lib_dry: '', data_prev_lib_reefer: '', data_lib_reefer: '',
  };
  for (const [k, v] of Object.entries(d)) campos[`data_${k}`] = typeof v === 'string' ? v : utc(v);
  return { navio, nro_viagem: viagem, armador, terminal, timezone: 'UTC', ...campos };
}

// Amostras reais devolvidas pelo DSS em 27/10/2026 (uma de cada terminal).
const REAIS = {
  btp: { armador: 'MSC', data_abertura_gate: '2026-10-13 16:00:00', data_atracacao: '2026-10-16 17:47:00', data_deadline: '2026-10-15 13:00:00', data_lib_dry: '', data_lib_reefer: '2026-10-13 16:00:00', data_prev_abertura_gate: '', data_prev_atracacao: '', data_prev_chegada: '2026-10-15 10:00:00', data_prev_lib_dry: '', data_prev_lib_reefer: '', data_prev_saida: '2026-10-17 20:00:00', navio: 'MSC URSULA VI', nro_viagem: 'UA641R', terminal: 'btp', timezone: 'UTC' },
  santos: { armador: 'UX641R', data_abertura_gate: '2026-10-15 22:00:00', data_atracacao: '', data_deadline: '2026-10-16 15:00:00', data_lib_dry: '', data_lib_reefer: '2026-10-15 22:00:00', data_prev_abertura_gate: '', data_prev_atracacao: '', data_prev_chegada: '2026-10-21 04:00:00', data_prev_lib_dry: '', data_prev_lib_reefer: '', data_prev_saida: '', navio: 'MSC PERLE', nro_viagem: 'UX641R', terminal: 'santos_brasil', timezone: 'UTC' },
  santos2: { armador: 'BRA030N99', data_abertura_gate: '2026-10-16 21:00:00', data_atracacao: '', data_deadline: '2026-10-20 15:00:00', data_lib_dry: '', data_lib_reefer: '2026-10-16 21:00:00', data_prev_abertura_gate: '', data_prev_atracacao: '', data_prev_chegada: '2026-10-21 13:30:00', data_prev_lib_dry: '', data_prev_lib_reefer: '', data_prev_saida: '', navio: 'MERCOSUL GUARUJA', nro_viagem: 'BRA030N99', terminal: 'santos_brasil', timezone: 'UTC' },
  embraport: { armador: 'COS', data_abertura_gate: '', data_atracacao: '2026-12-05 10:00:00', data_deadline: '', data_lib_dry: '', data_lib_reefer: '', data_prev_abertura_gate: '', data_prev_atracacao: '', data_prev_chegada: '2026-10-12 09:00:00', data_prev_lib_dry: '', data_prev_lib_reefer: '', data_prev_saida: '2026-12-06 10:00:00', navio: 'COSCO SHIPPING CHANG SHENG', nro_viagem: '010', terminal: 'embraport', timezone: 'UTC' },
};

test('datas UTC do DSS', () => {
  assert.equal(dataUtc('2024-07-20 18:00:00'), '2024-07-20T18:00:00.000Z');
  assert.equal(dataUtc('2024-07-20 18:00'), '2024-07-20T18:00:00.000Z');
  assert.equal(dataUtc(''), null);
  assert.equal(dataUtc('string'), null);
});

// ------------------------------------------------------------------ correções de leitura
test('correção 1: data "real" no futuro vira previsão (gate BTP, atracação Embraport)', () => {
  const gate = normalizar(registro('MSC INSA', 'NA642R', 'btp', { prev_chegada: -100, abertura_gate: 30, deadline: 70 }), AGORA);
  assert.equal(gate.datas.aberturaGate, null);
  assert.equal(gate.datas.prevAberturaGate, new Date(AGORA + 30 * H).toISOString());
  assert.equal(gate.situacao.gate, 'aguardando', 'antes da correção aparecia como aberto');
  assert.ok(gate.qualidade.some((q) => q.problema === 'data_real_no_futuro' && q.campo === 'data_abertura_gate'));

  const emb = normalizarTodos([REAIS.embraport, registro('X', '1', 'embraport', { atracacao: -5, prev_saida: 20 })], AGORA)[0];
  assert.equal(emb.datas.atracacao, null);
  assert.equal(emb.datas.prevAtracacao, '2026-12-05T10:00:00.000Z');
  assert.equal(emb.situacao.navio, 'aguardando_atracacao', 'chegada prevista em 12/10 e ainda não atracou');
});

test('correção 2: na BTP e na Santos Brasil, lib_reefer é a abertura de gate reefer', () => {
  const btp = normalizar(REAIS.btp, AGORA);
  assert.equal(btp.datas.liberacaoReefer, null);
  assert.equal(btp.datas.aberturaGateReefer, '2026-10-13T16:00:00.000Z');
  assert.equal(btp.situacao.reefer, 'sem_dado', 'antes aparecia como "liberado"');
  assert.equal(btp.situacao.gateReefer, 'encerrado');

  const futuro = normalizar(registro('MSC INSA', 'NA642R', 'santos_brasil', { prev_chegada: 20, abertura_gate: 10, lib_reefer: 12, deadline: 40 }), AGORA);
  assert.equal(futuro.datas.prevAberturaGateReefer, new Date(AGORA + 12 * H).toISOString());
  assert.equal(futuro.situacao.gateReefer, 'aguardando');

  const embraport = normalizar(registro('Y', '2', 'embraport', { prev_lib_reefer: 30, lib_dry: -2 }), AGORA);
  assert.equal(embraport.situacao.reefer, 'previsto', 'na Embraport o campo continua sendo liberação de importação');
  assert.equal(embraport.situacao.dry, 'liberado');
});

test('correção 3: sem prev_atracacao, a espera é medida pela chegada prevista', () => {
  const lista = normalizarTodos(
    [
      registro('ESPERANDO', '1N', 'btp', { prev_chegada: -30, prev_saida: 40 }),
      registro('ATRACADO', '2N', 'btp', { prev_chegada: -40, atracacao: -10, prev_saida: 15 }),
      registro('ENCERRADO', '3N', 'btp', { prev_chegada: -80, atracacao: -60, prev_saida: -5 }),
      registro('A CAMINHO', '4N', 'btp', { prev_chegada: 12 }),
      registro('MSC SANTOS', '5N', 'santos_brasil', { prev_chegada: -20 }),
      registro('MSC MADHU B', 'QI639R', 'btp', { prev_chegada: -203, prev_saida: -98 }),
    ],
    AGORA,
  );
  const [esperando, atracado, encerrado, aCaminho, santos, saiuSemAtracacao] = lista;
  assert.equal(saiuSemAtracacao.situacao.navio, 'encerrado', 'saída prevista passou: não fica "aguardando" por dias');
  assert.ok(saiuSemAtracacao.qualidade.some((q) => q.problema === 'saida_sem_atracacao'));
  assert.equal(esperando.situacao.navio, 'aguardando_atracacao');
  assert.equal(esperando.horas.esperaAtracacao, 30);
  assert.equal(atracado.situacao.navio, 'atracado');
  assert.equal(atracado.horas.atrasoAtracacao, 30, 'atracação real − chegada prevista');
  assert.equal(encerrado.situacao.navio, 'encerrado');
  assert.equal(aCaminho.situacao.navio, 'previsto');
  assert.equal(santos.situacao.navio, 'chegada_passou', 'Santos Brasil não informa atracação');
});

test('correção 4: armador igual à viagem é deduzido', () => {
  const [btp, santos, mercosul] = normalizarTodos(
    [registro('MSC PERLE', 'UX640R', 'btp', {}, 'MSC'), REAIS.santos, REAIS.santos2, registro('NAVIO DESCONHECIDO', 'ZZ1', 'santos_brasil', {}, 'ZZ1')],
    AGORA,
  );
  assert.equal(btp.armadorOrigem, 'dss');
  assert.equal(santos.armador, 'MSC');
  assert.equal(santos.armadorOrigem, 'mesmo navio em outro registro');
  assert.ok(santos.qualidade.some((q) => q.problema === 'armador_igual_viagem'));
  assert.equal(mercosul.armador, 'ALI');
  assert.equal(mercosul.armadorOrigem, 'nome do navio');
  const desconhecido = normalizarTodos([registro('NAVIO DESCONHECIDO', 'ZZ1', 'santos_brasil', {}, 'ZZ1')], AGORA)[0];
  assert.equal(desconhecido.armador, null);
});

test('correção 5: datas a mais de 1 ano são descartadas como suspeitas', () => {
  const r = normalizar(registro('FUTURISTA', '1', 'santos_brasil', { prev_chegada: 10, deadline: '2044-12-19 03:00:00' }), AGORA);
  assert.equal(r.datas.deadline, null);
  assert.deepEqual(r.datasSuspeitas, { data_deadline: '2044-12-19T03:00:00.000Z' });
  assert.equal(r.situacao.gate, 'sem_dado');
});

// ------------------------------------------------------------------ filtros e resumo
const AMOSTRA = [
  registro('MSC INSA', 'NA642R', 'btp', { prev_chegada: -100, prev_saida: 55, abertura_gate: -78, lib_reefer: -78, deadline: 20, prev_lib_dry: 30 }),
  registro('XIAMEN EXPRESS', 'NA641R', 'btp', { prev_chegada: -150, prev_saida: 20, abertura_gate: -200, deadline: -60 }, 'HLC'),
  registro('MAERSK LOTA', '644N', 'embraport', { prev_chegada: -40, atracacao: -18, prev_saida: 10, deadline: -50, prev_lib_reefer: -6 }, 'MAE'),
  registro('COPIAPO', 'MM643R', 'btp', { prev_chegada: 40, prev_saida: 70, abertura_gate: 30, lib_reefer: 32, deadline: 44 }, 'HLC'),
  registro('MSC PERLE', 'UX641R', 'santos_brasil', { prev_chegada: 10, deadline: 30 }, 'UX641R'),
  registro('SAN RAPHAEL MAERSK', '642N', 'btp', { prev_chegada: -80, atracacao: -49, prev_saida: 5 }, 'MAE'),
];

test('filtros', () => {
  const todos = normalizarTodos(AMOSTRA, AGORA);
  const nomes = (q) => filtrar(todos, q).map((r) => r.navio);
  assert.deepEqual(nomes({ terminal: 'btp' }), ['MSC INSA', 'XIAMEN EXPRESS', 'COPIAPO', 'SAN RAPHAEL MAERSK']);
  assert.deepEqual(nomes({ armador: 'msc' }), ['MSC INSA', 'MSC PERLE'], 'armador deduzido também filtra');
  assert.deepEqual(nomes({ situacao: 'aguardando_atracacao' }), ['MSC INSA', 'XIAMEN EXPRESS']);
  assert.deepEqual(nomes({ gate: 'aguardando' }), ['COPIAPO', 'MSC PERLE']);
  assert.deepEqual(nomes({ navio: 'msc', viagem: 'na642r' }), ['MSC INSA']);
});

test('resumo das próximas horas', () => {
  const r = resumir(normalizarTodos(AMOSTRA, AGORA), { horas: 48, agora: AGORA });
  assert.deepEqual(r.porSituacao, { aguardando_atracacao: 2, atracado: 2, previsto: 2 });
  assert.deepEqual(r.porGate, { aberto: 1, encerrado: 2, aguardando: 2, sem_dado: 1 });
  assert.deepEqual(r.porGateReefer, { aberto: 1, sem_dado: 4, aguardando: 1 });
  assert.deepEqual(r.deadlines.map((x) => x.navio), ['MSC INSA']);
  assert.deepEqual(r.aberturasGate.map((x) => `${x.navio}:${x.tipo}`), ['COPIAPO:dry', 'COPIAPO:reefer']);
  assert.deepEqual(r.aguardandoAtracacao.map((x) => [x.navio, x.horasDeEspera]), [['XIAMEN EXPRESS', 150], ['MSC INSA', 100]]);
  assert.deepEqual(r.liberacoes.map((x) => x.tipo), ['dry']);
  assert.deepEqual(r.atrasados.map((x) => x.navio), ['MAERSK LOTA'], 'reefer de importação da Embraport atrasado');
  assert.equal(r.qualidade['santos_brasil:armador_igual_viagem'], 1);
  assert.equal(r.qualidade['btp:reefer_e_abertura_de_gate'], 2);
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
const ok = (registros = AMOSTRA) => ({ status: 200, apiVersion: 1, mensagemErro: '', timezone: 'UTC', qtd_registros: registros.length, registros });

test('Basic Auth (inclusive embutido na URL), cache e consulta compartilhada', async () => {
  const f = fetchFalso([{ status: 200, corpo: ok() }]);
  const c = criarCliente({ url: 'https://us%40r:s3nh%40@dss.exemplo.com/wsdss/navios/listarNavios', fetch: f, cacheSegundos: 60, intervaloMinimoForcarMs: 0 });
  const [a] = await Promise.all([c.listar(), c.listar()]);
  await c.listar();
  assert.equal(f.chamadas.length, 1);
  assert.equal(f.chamadas[0].url, 'https://dss.exemplo.com/wsdss/navios/listarNavios');
  assert.equal(f.chamadas[0].auth, `Basic ${Buffer.from('us@r:s3nh@').toString('base64')}`);
  assert.equal(a.qtdRegistros, 6);
  assert.equal(a.registros.find((r) => r.navio === 'MSC PERLE').armador, 'MSC', 'contexto da resposta inteira');
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
  const c = criarCliente({ url: 'https://dss.exemplo.com/x', fetch: f, cacheSegundos: 60, intervaloMinimoForcarMs: 0 });
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
    assert.equal(navios.corpo.total, 4);
    assert.deepEqual(navios.corpo.armadores, ['HLC', 'MAE', 'MSC'], 'sem códigos de viagem no filtro de armador');
    assert.equal((await get('/api/resumo?horas=72')).corpo.proximasHoras, 72);
    assert.equal((await get('/api/dss/bruto')).corpo.registros[0].nro_viagem, 'NA642R');
    assert.match((await get('/')).corpo, /Portal de Navios/);
    assert.equal((await get('/api/nada')).status, 404);
    assert.equal((await fetch(`${base}/api/navios`, { method: 'POST' })).status, 405);
  } finally {
    srv.close();
  }
  const semDss = criarServidor(null);
  await new Promise((r) => semDss.listen(0, r));
  assert.equal((await fetch(`http://127.0.0.1:${semDss.address().port}/api/navios`)).status, 503);
  semDss.close();
});

// ------------------------------------------------------------------ parte 2: desempenho
test('janela de trabalho: dias=N sem encerrados e sem registros antigos', () => {
  const todos = normalizarTodos(
    [
      registro('PROXIMO', '1', 'btp', { prev_chegada: 24, prev_saida: 60 }),
      registro('DISTANTE', '2', 'btp', { prev_chegada: 24 * 20 }),
      registro('ATRACADO', '3', 'btp', { prev_chegada: -30, atracacao: -10, prev_saida: 20 }),
      registro('SAIU', '4', 'btp', { prev_chegada: -60, atracacao: -50, prev_saida: -5 }),
      registro('FANTASMA', '5', 'santos_brasil', { prev_chegada: -24 * 6, deadline: -24 * 7 }),
    ],
    AGORA,
  );
  const nomes = (q) => filtrar(todos, q, AGORA).map((r) => r.navio);
  assert.deepEqual(nomes({ dias: '7' }), ['PROXIMO', 'ATRACADO']);
  assert.deepEqual(nomes({ dias: '7', encerrados: 'true' }), ['PROXIMO', 'ATRACADO', 'SAIU']);
  assert.deepEqual(nomes({ dias: '30' }), ['PROXIMO', 'DISTANTE', 'ATRACADO']);
  assert.equal(nomes({}).length, 5, 'sem dias: tudo, como antes');
});

test('atualização em segundo plano: a página não espera o DSS e o "consultar agora" tem intervalo mínimo', async () => {
  const f = fetchFalso([{ status: 200, corpo: ok() }]);
  const c = criarCliente({ url: 'https://dss.exemplo.com/x', fetch: f, cacheSegundos: 0.05, intervaloMinimoForcarMs: 60000 });
  const parar = c.iniciarAtualizacao(30);
  await new Promise((r) => setTimeout(r, 120));
  const antes = f.chamadas.length;
  assert.ok(antes >= 3, `consultou sozinho ${antes} vezes`);
  await c.listar({ forcar: true });
  await c.listar({ forcar: true });
  assert.ok(f.chamadas.length <= antes + 1, 'forçar não dispara uma consulta por clique');
  parar();
});

test('servidor: gzip, ETag/304 e /api/painel numa chamada só', async () => {
  const f = fetchFalso([{ status: 200, corpo: ok() }]);
  const srv = criarServidor(criarCliente({ url: 'https://dss.exemplo.com/x', fetch: f }));
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const http = require('node:http');
  const zlib = require('node:zlib');
  const pedir = (p, headers = {}) =>
    new Promise((resolve, reject) => {
      http.get(base + p, { headers }, (res) => {
        const partes = [];
        res.on('data', (x) => partes.push(x));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(partes) }));
      }).on('error', reject);
    });
  try {
    const comGzip = await pedir('/api/painel?dias=7', { 'accept-encoding': 'gzip' });
    assert.equal(comGzip.status, 200);
    assert.equal(comGzip.headers['content-encoding'], 'gzip');
    const json = JSON.parse(zlib.gunzipSync(comGzip.corpo));
    assert.ok(Array.isArray(json.navios) && json.resumo && json.resumo.porSituacao, 'lista e resumo juntos');
    const semGzip = await pedir('/api/painel?dias=7');
    assert.equal(semGzip.headers['content-encoding'], undefined);
    assert.ok(comGzip.corpo.length < semGzip.corpo.length);

    const etag = semGzip.headers.etag;
    assert.ok(etag);
    const denovo = await pedir('/api/painel?dias=7', { 'if-none-match': etag });
    assert.equal(denovo.status, 304);
    assert.equal(denovo.corpo.length, 0);

    const pagina = await pedir('/', { 'accept-encoding': 'gzip' });
    assert.equal(pagina.headers['content-encoding'], 'gzip');
    const health = JSON.parse((await pedir('/api/health')).corpo);
    assert.equal(health.registros, 6);
    assert.ok(health.idadeSegundos >= 0);
  } finally {
    srv.close();
  }
});

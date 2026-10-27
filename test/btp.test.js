'use strict';

// Planilha da BTP: leitura dos formatos, datas, status, comparação com o DSS e rotas.
process.env.DSS_URL = 'https://tms.exemplo.com.br/wsdss/navios/listarNavios';
process.env.DSS_USUARIO = 'usuario';
process.env.DSS_SENHA = 'senha';
process.env.DATABASE_URL = '';
process.env.TOLERANCIA_HORAS = '1';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const btp = require('../src/services/btp');
const { iniciar } = require('../src/server');
const { criarArmazenamento } = require('../src/db');

const arquivo = (nome) => fs.readFileSync(path.join(__dirname, 'arquivos', nome));

// ---------------------------------------------------------------------------- leitura
test('os quatro formatos dão o mesmo resultado', () => {
  const resultados = ['btp.xlsx', 'btp-libreoffice.xlsx', 'btp-html.xls', 'btp.csv'].map((n) => btp.importarPlanilha(arquivo(n)));
  assert.deepEqual(resultados.map((r) => r.formato), ['xlsx', 'xlsx', 'html', 'csv']);
  for (const r of resultados) {
    assert.equal(r.registros.length, 6);
    assert.deepEqual(r.avisos, []);
    assert.deepEqual(r.registros, resultados[0].registros);
  }
});

test('horário de Brasília vira UTC (confere com o valor exato do sistema da BTP)', () => {
  const xiamen = btp.importarPlanilha(arquivo('btp.xlsx')).registros.find((r) => r.navio === 'XIAMEN EXPRESS');
  // No sistema da BTP: DtChegada "22/10/2026 03:50:00" = /Date(1792651800000)/
  assert.equal(xiamen.chegada, new Date(1792651800000).toISOString());
  // DtPrevAtracacao "31/10/2026 01:00:00" = /Date(1793419200000)/
  assert.equal(xiamen.prevAtracacao, new Date(1793419200000).toISOString());
  assert.equal(btp.dataBrasiliaParaUtc('28/10/2026 23:30'), '2026-10-29T02:30:00.000Z');
  assert.equal(btp.dataBrasiliaParaUtc(''), null);
  assert.equal(btp.dataBrasiliaParaUtc('—'), null);
});

test('status igual ao da tela da BTP e campos de texto', () => {
  const r = Object.fromEntries(btp.importarPlanilha(arquivo('btp.csv')).registros.map((x) => [x.navio, x]));
  assert.equal(r['MSC MADHU B'].status, 'desatracado');
  assert.equal(r['SAN RAPHAEL MAERSK'].status, 'atracado');
  assert.equal(r['XIAMEN EXPRESS'].status, 'na_barra');
  assert.equal(r['MAERSK PANGANI'].status, 'previsto');
  assert.equal(r['MSC MADHU B'].rap, '04658 2026');
  assert.equal(r['MSC NERISSA V'].rap, null);
  assert.equal(r['MSC INSA'].berco, 'BTP 2');
  assert.equal(r['MSC INSA'].servico, 'NWC1');
  assert.deepEqual(btp.contarStatus(Object.values(r)), { previsto: 2, na_barra: 2, atracado: 1, desatracado: 1 });
});

test('arquivos que não servem são recusados com orientação', () => {
  assert.throws(() => btp.importarPlanilha(arquivo('btp-antigo.xls')), (e) => e.status === 415 && /salve como \.xlsx/.test(e.message));
  assert.throws(() => btp.importarPlanilha(Buffer.from('a;b;c\n1;2;3\n')), /linha de títulos/);
  assert.throws(() => btp.importarPlanilha(Buffer.alloc(0)), /vazio/);
});

// ---------------------------------------------------------------------------- comparação
test('comparação com o DSS: diferenças, viagem diferente e registros de um lado só', () => {
  const registros = btp.importarPlanilha(arquivo('btp.csv')).registros;
  const iso = (s) => btp.dataBrasiliaParaUtc(s);
  const dss = [
    // MSC INSA: igual à BTP, exceto deadline 3 h depois
    { navio: 'MSC INSA', viagem: 'NA642R', terminal: 'btp', datas: { prevChegada: iso('22/10/2026 16:00:00'), prevAtracacao: iso('27/10/2026 19:00:00'), atracacao: null, prevSaida: iso('28/10/2026 20:00:00'), deadline: iso('25/10/2026 15:00:00'), aberturaGate: iso('24/10/2026 13:00:00') } },
    // XIAMEN EXPRESS: igual (30 min de diferença na previsão de atracação, dentro da tolerância)
    { navio: 'XIAMEN EXPRESS', viagem: 'NA641R', terminal: 'btp', datas: { prevChegada: iso('22/10/2026 03:50:00'), prevAtracacao: iso('31/10/2026 01:30:00'), atracacao: null, prevSaida: iso('01/11/2026 19:00:00'), deadline: iso('21/10/2026 18:00:00'), prevAberturaGate: iso('19/10/2026 19:00:00') } },
    // MAERSK PANGANI com outra viagem no DSS
    { navio: 'MAERSK PANGANI', viagem: '643S', terminal: 'btp', datas: { prevChegada: iso('28/10/2026 07:00:00'), prevAtracacao: iso('29/10/2026 23:30:00'), prevSaida: iso('31/10/2026 03:30:00'), deadline: iso('28/10/2026 12:00:00'), prevAberturaGate: iso('20/10/2026 07:00:00') } },
    // Só no DSS
    { navio: 'NAVIO SO NO DSS', viagem: '1A', terminal: 'btp', referencia: iso('30/10/2026 10:00:00'), datas: {} },
    // Outro terminal: ignorado
    { navio: 'MSC INSA', viagem: 'NA642R', terminal: 'santos_brasil', datas: {} },
  ];
  const c = btp.compararComDss(registros, dss, { toleranciaHoras: 1 });
  assert.deepEqual(c.resumo, { naPlanilha: 6, noDssBtp: 4, conferidos: 3, comDivergencia: 2, somenteNaPlanilha: 2, somenteNoDss: 1 });
  const insa = c.divergencias.find((d) => d.navio === 'MSC INSA');
  assert.deepEqual(insa.diferencas.map((d) => [d.campo, d.diferencaHoras]), [['Deadline', 3]]);
  const pangani = c.divergencias.find((d) => d.navio === 'MAERSK PANGANI');
  assert.match(pangani.aviso, /Viagem diferente/);
  assert.deepEqual(c.somenteNaPlanilha.map((r) => r.navio).sort(), ['MSC NERISSA V', 'SAN RAPHAEL MAERSK'], 'desatracados não entram');
  assert.equal(c.somenteNoDss[0].navio, 'NAVIO SO NO DSS');
});

// ---------------------------------------------------------------------------- rotas
const fetchOriginal = global.fetch;
let respostaDss = { status: 403, corpo: { status: 403, apiVersion: 1, mensagemErro: 'Cliente não está habilitado para utilizar esse endpoint. Instale o módulo tms_integr_portal_navios para utilizar.' } };
global.fetch = async (url, opcoes) => {
  if (new URL(String(url)).hostname === 'tms.exemplo.com.br') {
    return new Response(JSON.stringify(respostaDss.corpo), { status: respostaDss.status });
  }
  return fetchOriginal(url, opcoes);
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

async function json(caminho, opcoes = {}) {
  const res = await fetch(base + caminho, opcoes);
  const texto = await res.text();
  return { status: res.status, corpo: texto ? JSON.parse(texto) : null };
}

test('sem planilha: lineup 404 e previsão devolve o erro do DSS', async () => {
  assert.equal((await json('/api/btp/lineup')).status, 404);
  const p = await json('/api/previsao-entrada');
  assert.equal(p.status, 502);
  assert.match(p.corpo.erro, /tms_integr_portal_navios/);
});

test('importa a planilha enviando o arquivo no corpo', async () => {
  const r = await json('/api/btp/planilha?nome=lista.xlsx', { method: 'POST', body: arquivo('btp.xlsx'), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.formato, 'xlsx');
  assert.equal(r.corpo.total, 6);
  assert.deepEqual(r.corpo.porStatus, { previsto: 2, na_barra: 2, atracado: 1, desatracado: 1 });
  const lineup = await json('/api/btp/lineup');
  assert.equal(lineup.corpo.nomeArquivo, 'lista.xlsx');
  assert.equal(lineup.corpo.registros.length, 6);

  const ruim = await json('/api/btp/planilha', { method: 'POST', body: arquivo('btp-antigo.xls') });
  assert.equal(ruim.status, 415);
});

test('com o DSS fora (403), a previsão usa a planilha e avisa', async () => {
  await json('/api/conteineres', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ numero: 'MSCU1234566', navioNome: 'MSC NERISSA V' }) });
  const { status, corpo } = await json('/api/previsao-entrada?dias=30');
  assert.equal(status, 200);
  assert.equal(corpo.fonte, 'planilha-btp');
  assert.match(corpo.avisos[0].mensagem, /tms_integr_portal_navios.*planilha da BTP/);
  assert.ok(!corpo.navios.some((n) => n.navio === 'MSC MADHU B'), 'desatracado fica de fora');
  const nerissa = corpo.navios.find((n) => n.navio === 'MSC NERISSA V');
  assert.equal(nerissa.totalConteineres, 1);
  assert.equal(nerissa.btp.status, 'previsto');
  assert.equal(corpo.navios.find((n) => n.navio === 'XIAMEN EXPRESS').btp.status, 'na_barra');
  assert.equal(corpo.resumo.naBarra, 2);
});

test('com o DSS no ar, a previsão usa o DSS e acrescenta os dados da BTP', async () => {
  const utc = (s) => btp.dataBrasiliaParaUtc(s).replace('T', ' ').slice(0, 19);
  const agora = new Date();
  const futuro = (h) => new Date(agora.getTime() + h * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  respostaDss = {
    status: 200,
    corpo: {
      status: 200, apiVersion: 1, mensagemErro: '', timezone: 'UTC', qtd_registros: 2,
      registros: [
        { navio: 'MSC NERISSA V', nro_viagem: 'UA644B', armador: 'MSC', terminal: 'btp', data_prev_chegada: futuro(10), data_prev_atracacao: futuro(20), data_prev_saida: futuro(40), data_deadline: utc('02/11/2026 12:00:00'), data_atracacao: '' },
        { navio: 'NAVIO SANTOS BRASIL', nro_viagem: '9X', armador: 'MSC', terminal: 'santos_brasil', data_prev_chegada: futuro(15), data_prev_atracacao: futuro(25), data_prev_saida: futuro(45), data_atracacao: '' },
      ],
    },
  };
  const { corpo } = await json('/api/previsao-entrada?dias=7');
  assert.equal(corpo.fonte, 'dss');
  assert.deepEqual(corpo.avisos, []);
  const nerissa = corpo.navios.find((n) => n.navio === 'MSC NERISSA V');
  assert.equal(nerissa.btp.berco, 'BTP 1');
  assert.equal(nerissa.btp.viagemConfere, true);
  assert.equal(corpo.navios.find((n) => n.terminal === 'santos_brasil').btp, null);

  const comp = await json('/api/btp/comparacao');
  assert.equal(comp.status, 200);
  assert.equal(comp.corpo.resumo.noDssBtp, 1);
  assert.ok(comp.corpo.divergencias.length >= 1, 'datas diferentes entre o DSS simulado e a planilha');
});

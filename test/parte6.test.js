'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarCliente } = require('../src/dss');
const { criarMemoria } = require('../src/historico');
const { criarMemoria: criarArmazem, criarMapa } = require('../src/armazem');
const { criarServidor } = require('../src/server');
const { avaliarConfiabilidade, frases } = require('../src/confiabilidade');
const { criarCalendario } = require('../src/ics');
const { criarEtracking, cruzar, normalizarConteiner, acharLista } = require('../src/etracking');

const H = 36e5;
const f = (h, base = Date.now()) => new Date(Math.floor(base / H) * H + h * H).toISOString().replace('T', ' ').slice(0, 19);
const reg = (navio, viagem, terminal, datas, armador = 'MSC') => ({ navio, nro_viagem: viagem, armador, terminal, timezone: 'UTC', ...datas });

async function subir(corpos) {
  let i = 0;
  const fetchDss = async () => {
    const registros = corpos[Math.min(i++, corpos.length - 1)];
    return new Response(JSON.stringify({ status: 200, apiVersion: 1, timezone: 'UTC', qtd_registros: registros.length, registros }), { status: 200 });
  };
  const historico = criarMemoria();
  await historico.iniciar();
  const armazem = criarArmazem();
  const cliente = criarCliente({ url: 'https://dss.exemplo.com/x', fetch: fetchDss, intervaloMinimoForcarMs: 0, aoAtualizar: (r, em) => historico.registrar(r, em) });
  const srv = criarServidor(cliente, historico, null, armazem);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, corpo: res.headers.get('content-type').includes('json') ? await res.json() : await res.text(), res };
  };
  const enviar = async (metodo, p, corpo) => {
    const res = await fetch(base + p, { method: metodo, headers: corpo ? { 'content-type': 'application/json' } : {}, body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: res.status, corpo: await res.json() };
  };
  const atualizar = async () => {
    await get('/api/navios?atualizar=true');
    await new Promise((r) => setTimeout(r, 20));
  };
  return { srv, get, enviar, atualizar, historico };
}

test('tabela de armadores: aplica onde o DSS não traz armador válido, viagem antes do navio', async () => {
  const regs = [
    reg('LOG-IN JACARANDA', 'LJ12', 'santos_brasil', { data_prev_chegada: f(10), data_prev_saida: f(40) }, 'LJ12'),
    reg('LOG-IN JACARANDA', 'LJ13', 'santos_brasil', { data_prev_chegada: f(100), data_prev_saida: f(130) }, 'LJ13'),
    reg('MSC INSA', 'NA642R', 'btp', { data_prev_chegada: f(5), data_prev_saida: f(30) }, 'MSC'),
  ];
  const s = await subir([regs]);
  await s.atualizar();
  let a = (await s.get('/api/armadores')).corpo;
  assert.deepEqual(a.semArmador.map((n) => n.viagem), ['LJ12', 'LJ13']);
  assert.equal((await s.enviar('POST', '/api/armadores', { tipo: 'navio', valor: 'LOG-IN JACARANDA', armador: 'log', autor: 'Ana' })).status, 200);
  assert.equal((await s.enviar('POST', '/api/armadores', { tipo: 'viagem', valor: 'LJ13', armador: 'MAE' })).status, 200);
  const navios = (await s.get('/api/navios')).corpo.navios;
  const por = Object.fromEntries(navios.map((n) => [n.viagem, n]));
  assert.equal(por.LJ12.armador, 'LOG');
  assert.equal(por.LJ12.armadorOrigem, 'tabela de armadores');
  assert.equal(por.LJ13.armador, 'MAE', 'regra da viagem vence a do navio');
  assert.equal(por.NA642R.armadorOrigem, 'dss', 'armador válido do DSS não é trocado');
  a = (await s.get('/api/armadores')).corpo;
  assert.equal(a.regras.length, 2);
  assert.equal(a.regras.find((r) => r.tipo === 'navio').autor, 'Ana');
  // validações
  assert.equal((await s.enviar('POST', '/api/armadores', { tipo: 'outro', valor: 'X', armador: 'Y' })).status, 400);
  const semJson = await fetch(`${s.srv.address().port ? `http://127.0.0.1:${s.srv.address().port}` : ''}/api/armadores`, { method: 'POST', body: 'tipo=navio' });
  assert.equal(semJson.status, 400, 'só aceita JSON');
  // remover
  const id = a.regras.find((r) => r.tipo === 'viagem').id;
  await s.enviar('DELETE', `/api/armadores?id=${id}`);
  assert.equal((await s.get('/api/navios')).corpo.navios.find((n) => n.viagem === 'LJ13').armador, 'LOG');
  s.srv.close();
});

test('observações: gravar, contar no painel, ver no detalhe e apagar', async () => {
  const regs = [reg('MSC INSA', 'NA642R', 'btp', { data_prev_chegada: f(5), data_prev_saida: f(30), data_deadline: f(3) })];
  const s = await subir([regs]);
  await s.atualizar();
  const chave = 'btp|MSCINSA|NA642R';
  const r = await s.enviar('POST', '/api/observacoes', { chave, texto: '  Booking confirmado  ', autor: 'João', navio: 'MSC INSA' });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.observacao.texto, 'Booking confirmado');
  assert.equal((await s.enviar('POST', '/api/observacoes', { chave, texto: '' })).status, 400);
  assert.equal((await s.enviar('POST', '/api/observacoes', { chave: 'x', texto: 'a' })).status, 400);
  const painel = (await s.get('/api/painel?dias=tudo')).corpo;
  assert.equal(painel.navios[0].observacoes, 1);
  const d = (await s.get(`/api/navio?chave=${encodeURIComponent(chave)}`)).corpo;
  assert.equal(d.observacoes[0].autor, 'João');
  assert.equal(d.conteineres, null, 'sem eTracking, nada de contêineres');
  await s.enviar('DELETE', `/api/observacoes?id=${r.corpo.observacao.id}`);
  assert.equal((await s.get(`/api/navio?chave=${encodeURIComponent(chave)}`)).corpo.observacoes.length, 0);
  s.srv.close();
});

test('viagens passadas: navio que saiu da lista continua consultável, com detalhe', async () => {
  const insa = reg('MSC INSA', 'NA642R', 'btp', { data_prev_chegada: f(-90), data_atracacao: f(-80), data_prev_saida: f(-10) });
  const perle = reg('MSC PERLE', 'UX641R', 'btp', { data_prev_chegada: f(10), data_prev_saida: f(40) });
  const s = await subir([[insa, perle], [perle]]);
  await s.atualizar();
  await s.atualizar(); // INSA sai da lista
  const v = (await s.get('/api/viagens')).corpo;
  assert.equal(v.total, 1);
  assert.equal(v.viagens[0].navio, 'MSC INSA');
  assert.equal(v.viagens[0].removido, true);
  assert.ok(v.viagens[0].removidoEm);
  assert.ok(v.viagens[0].datas.atracacao, 'atracação real guardada');
  assert.equal((await s.get('/api/viagens?todas=true')).corpo.total, 2);
  assert.equal((await s.get('/api/viagens?navio=perle')).corpo.total, 0, 'PERLE ainda está ativo');
  const d = (await s.get(`/api/navio?chave=${encodeURIComponent('btp|MSCINSA|NA642R')}`)).corpo;
  assert.equal(d.navio.navio, 'MSC INSA');
  assert.equal(d.passado.removido, true);
  s.srv.close();
});

test('confiabilidade: deslocamento líquido por navio, agrupado por terminal e armador', () => {
  const em = (h) => new Date(Date.UTC(2026, 9, 20) + h * H).toISOString();
  const mud = (chave, terminal, de, para, h, campo = 'data_prev_chegada') => ({ em: em(h), chave, terminal, navio: chave.split('|')[1], viagem: chave.split('|')[2], campo, de, para });
  const mudancas = [
    mud('santos_brasil|A|1', 'santos_brasil', '2026-10-25 10:00:00', '2026-10-25 20:00:00', 1),
    mud('santos_brasil|A|1', 'santos_brasil', '2026-10-25 20:00:00', '2026-10-26 04:00:00', 2), // A: +18 h no total
    mud('santos_brasil|B|2', 'santos_brasil', '2026-10-26 10:00:00', '2026-10-26 00:00:00', 3), // B: -10 h
    mud('btp|C|3', 'btp', '2026-10-27 10:00:00', '2026-10-27 16:00:00', 4), // C: +6 h
    mud('btp|C|3', 'btp', '2026-10-27 16:00:00', '2026-10-27 10:00:00', 5), // C volta ao início: 0
    mud('btp|D|4', 'btp', null, '2026-10-27 10:00:00', 6), // data informada: não conta
    mud('btp|C|3', 'btp', '2026-10-27 10:00:00', '2026-10-28 10:00:00', 7, 'data_deadline'), // outro campo
  ];
  const campos = new Set(['data_prev_chegada', 'data_deadline']);
  const navios = [
    { chave: 'santos_brasil|A|1', terminal: 'santos_brasil', armador: 'MSC', campos },
    { chave: 'santos_brasil|B|2', terminal: 'santos_brasil', armador: 'CMA', campos },
    { chave: 'santos_brasil|E|5', terminal: 'santos_brasil', armador: 'MSC', campos },
    { chave: 'btp|C|3', terminal: 'btp', armador: 'MSC', campos },
    { chave: 'btp|D|4', terminal: 'btp', armador: 'MAE', campos },
    { chave: 'btp|F|6', terminal: 'btp', armador: 'MAE', campos },
  ];
  const t = avaliarConfiabilidade(mudancas, navios, { campo: 'data_prev_chegada', agrupar: 'terminal' });
  const sb = t.find((g) => g.grupo === 'santos_brasil');
  assert.deepEqual([sb.navios, sb.mudaram, sb.pctMudaram, sb.mediaQuandoMuda, sb.adiaram, sb.anteciparam], [3, 2, 67, 4, 1, 1]);
  assert.equal(sb.maior.horas, 18);
  const btp = t.find((g) => g.grupo === 'btp');
  assert.deepEqual([btp.navios, btp.mudaram, btp.mediaQuandoMuda, btp.mudancas], [3, 0, null, 2]);
  const fr = frases(t, { campo: 'data_prev_chegada', agrupar: 'terminal' });
  assert.match(fr[0].texto, /^A Santos Brasil adia a chegada em média 4 h quando muda \(2 de 3 navios, 67%\)\.$/);
  const a = avaliarConfiabilidade(mudancas, navios, { campo: 'data_prev_chegada', agrupar: 'armador', minimo: 1 });
  assert.equal(a.find((g) => g.grupo === 'MSC').mediaQuandoMuda, 18);
  const dl = avaliarConfiabilidade(mudancas, navios, { campo: 'data_deadline', agrupar: 'terminal' });
  assert.equal(dl.find((g) => g.grupo === 'btp').mediaQuandoMuda, 24);
});

test('rota /api/confiabilidade com histórico real', async () => {
  const v1 = reg('MSC INSA', 'NA642R', 'btp', { data_prev_chegada: f(10), data_prev_saida: f(40) });
  const v2 = { ...v1, data_prev_chegada: f(24) };
  const s = await subir([[v1], [v2]]);
  await s.atualizar();
  await s.atualizar();
  const c = (await s.get('/api/confiabilidade?campo=data_prev_chegada&agrupar=terminal&dias=7')).corpo;
  assert.equal(c.grupos[0].grupo, 'btp');
  assert.equal(c.grupos[0].mediaQuandoMuda, 14);
  assert.ok(c.historicoDesde);
  s.srv.close();
});

test('calendário .ics: deadlines e gates, UID estável, texto escapado e linhas dobradas', async () => {
  const agora = Date.parse('2026-10-28T12:00:00Z');
  const navios = [
    { chave: 'btp|MSCINSA|NA642R', navio: 'MSC INSA', viagem: 'NA642R', terminal: 'btp', armador: 'MSC', situacao: { navio: 'previsto', gate: 'aberto' }, datas: { deadline: '2026-10-29T12:00:00.000Z', aberturaGate: '2026-10-25T10:00:00.000Z', prevAberturaGateReefer: '2026-10-27T10:00:00.000Z', prevChegada: '2026-10-30T10:00:00.000Z' } },
    { chave: 'btp|VELHO|1', navio: 'VELHO', viagem: '1', terminal: 'btp', situacao: { navio: 'encerrado', gate: 'encerrado' }, datas: { deadline: '2026-10-29T12:00:00.000Z' } },
    { chave: 'santos_brasil|A, B; C|2', navio: 'A, B; C', viagem: '2', terminal: 'santos_brasil', situacao: { navio: 'previsto', gate: 'aguardando' }, datas: { deadline: '2026-10-20T12:00:00.000Z' } },
  ];
  const ics = criarCalendario(navios, { agora, url: 'https://portal.exemplo.com' });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2, 'deadline + gate reefer; gate dry de 25/10 e deadline antigo ficam de fora; encerrado fora');
  assert.match(ics, /UID:deadline-btp\|MSCINSA\|NA642R@portal-de-navios/);
  assert.match(ics, /DTSTART:20261029T120000Z/);
  assert.match(ics, /TRIGGER:-PT120M/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'linhas com até 75 bytes');
  const esc = criarCalendario([{ ...navios[2], datas: { deadline: '2026-10-29T12:00:00.000Z' } }], { agora });
  assert.match(esc.replace(/\r\n /g, ''), /SUMMARY:Deadline: A\\, B\\; C \(Santos Brasil\)/);
});

test('rota /api/calendario.ics com só meus navios', async () => {
  const regs = [
    reg('MSC INSA', 'NA642R', 'btp', { data_prev_chegada: f(5), data_prev_saida: f(30), data_deadline: f(3) }),
    reg('MSC PERLE', 'UX641R', 'btp', { data_prev_chegada: f(15), data_prev_saida: f(40), data_deadline: f(13) }),
  ];
  const s = await subir([regs]);
  await s.atualizar();
  const r = await s.get(`/api/calendario.ics?tipos=deadline&chaves=${encodeURIComponent('btp|MSCPERLE|UX641R')}`);
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get('content-type'), /text\/calendar/);
  assert.equal((r.corpo.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(r.corpo, /MSC PERLE/);
  assert.match(r.corpo, /X-WR-CALNAME:Portal de Navios - meus navios/);
  s.srv.close();
});

test('eTracking: desligado sem URL; lê lista, mapeia campos e cruza com navio e viagem', async () => {
  assert.equal(criarEtracking({ env: {} }), null);
  assert.deepEqual(acharLista({ dados: { itens: [1] } }), [1]);
  const c = normalizarConteiner({ cntr: 'MSCU1234567', nm_navio: 'MSC INSA', voyage: 'NA642R', ds_status: 'Gate In realizado' }, { navio: 'nm_navio' }, /gate.?in/i);
  assert.deepEqual([c.conteiner, c.navio, c.viagem, c.noTerminal], ['MSCU1234567', 'MSC INSA', 'NA642R', true]);
  const navios = [{ chave: 'btp|MSCINSA|NA642R', navio: 'MSC INSA', viagem: 'NA642R' }, { chave: 'btp|MSCPERLE|UX641R', navio: 'MSC PERLE', viagem: 'UX641R' }];
  const { porChave, semNavio } = cruzar([c, { conteiner: 'X', navio: 'OUTRO NOME', viagem: 'UX641R' }, { conteiner: 'Y', navio: 'NADA', viagem: 'ZZ' }], navios);
  assert.equal(porChave.get('btp|MSCINSA|NA642R').length, 1);
  assert.equal(porChave.get('btp|MSCPERLE|UX641R').length, 1, 'viagem única basta');
  assert.equal(semNavio.length, 1);

  const chamadas = [];
  const et = criarEtracking({
    env: { ETRACKING_URL: 'https://etracking.exemplo.com/api', ETRACKING_TOKEN: 'abc', ETRACKING_LISTA: 'resultado.conteineres', ETRACKING_CAMPOS: '{"conteiner":"numero","entrada":"gate_in"}' },
    fetch: async (url, o) => {
      chamadas.push({ url, auth: o.headers.authorization });
      return new Response(JSON.stringify({ resultado: { conteineres: [{ numero: 'A1', navio: 'MSC INSA', viagem: 'NA642R', gate_in: '2026-10-27 10:00' }, { numero: 'A2', navio: 'MSC INSA', viagem: 'NA642R' }] } }), { status: 200 });
    },
    log: () => {},
  });
  await et.atualizar();
  assert.equal(chamadas[0].auth, 'Bearer abc');
  const e = et.estado(navios);
  assert.deepEqual([e.conteineres, e.casados, e.navios, e.erro], [2, 2, 1, null]);
  const lista = et.cruzar(navios).porChave.get('btp|MSCINSA|NA642R');
  assert.deepEqual(lista.map((x) => x.noTerminal), [true, false]);

  const ruim = criarEtracking({ env: { ETRACKING_URL: 'https://x' }, fetch: async () => new Response('<html>', { status: 200 }), log: () => {} });
  await ruim.atualizar();
  assert.match(ruim.estado().erro, /não devolveu JSON/);
});

test('armazém em memória e mapa de armadores', async () => {
  const a = criarArmazem();
  await a.armadores.salvar({ tipo: 'navio', valor: 'Log-In Jacarandá', armador: 'log' });
  await a.armadores.salvar({ tipo: 'navio', valor: 'LOG-IN JACARANDA', armador: 'ALI' });
  const regras = await a.armadores.listar();
  assert.equal(regras.length, 1, 'mesmo navio atualiza a regra');
  assert.equal(regras[0].armador, 'ALI');
  const mapa = criarMapa(regras);
  assert.equal(mapa.navio.get('LOGINJACARANDA'), 'ALI', 'acentos não atrapalham');
});

test('páginas /tv e /imprimir', async () => {
  const s = await subir([[reg('MSC INSA', 'NA642R', 'btp', { data_prev_chegada: f(5) })]]);
  for (const p of ['/tv', '/imprimir', '/']) {
    const r = await s.get(p);
    assert.equal(r.status, 200);
    assert.match(r.corpo, /<title>/);
  }
  s.srv.close();
});

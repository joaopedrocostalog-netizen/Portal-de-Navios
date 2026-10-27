'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarAlertas, criarEnvio, gerarEventos, montarEmail, memoriaSimples } = require('../src/alertas');
const { normalizarTodos } = require('../src/dss');

const H = 36e5;
const AGORA = Date.parse('2026-10-27T15:00:00Z');
const f = (h) => new Date(AGORA + h * H).toISOString().replace('T', ' ').slice(0, 19);
const reg = (navio, viagem, terminal, datas, armador = 'MSC') => ({ navio, nro_viagem: viagem, armador, terminal, timezone: 'UTC', ...datas });

const REGS = [
  reg('MSC INSA', 'NA642R', 'btp', { data_prev_chegada: f(10), data_abertura_gate: f(-30), data_deadline: f(20), data_prev_saida: f(60) }),
  reg('COPIAPO', 'MM643R', 'btp', { data_prev_chegada: f(40), data_abertura_gate: f(-2), data_deadline: f(50), data_prev_saida: f(90) }, 'HLC'),
  reg('LONGE', 'X1', 'embraport', { data_prev_chegada: f(100), data_prev_abertura_gate: f(70), data_deadline: f(90), data_prev_saida: f(130) }),
  reg('JA FOI', 'X2', 'embraport', { data_prev_chegada: f(-90), data_atracacao: f(-80), data_deadline: f(5), data_prev_saida: f(-10) }),
];
const navios = normalizarTodos(REGS, AGORA);
const mud = (navio, viagem, terminal, campo, de, para) => ({ em: new Date(AGORA).toISOString(), chave: `${terminal}|${navio.replace(/\W/g, '')}|${viagem}`, terminal, navio, viagem, campo, de, para });

test('regras: deadline em 24 h, gate aberto e mudanças de data', () => {
  const mudancas = [
    mud('MSC INSA', 'NA642R', 'btp', 'data_deadline', f(-4), f(20)),
    mud('COPIAPO', 'MM643R', 'btp', 'data_prev_chegada', f(40.5), f(40)),
    mud('COPIAPO', 'MM643R', 'btp', 'armador', 'MM643R', 'HLC'),
    mud('JA FOI', 'X2', 'embraport', 'data_deadline', f(2), f(5)),
  ];
  const e = gerarEventos(navios, mudancas, { agora: AGORA });
  assert.deepEqual(
    e.map((x) => `${x.tipo}:${x.navio}${x.gateTipo ? `:${x.gateTipo}` : ''}${x.campo ? `:${x.campo}` : ''}`),
    ['deadline:MSC INSA', 'gate:COPIAPO:dry', 'mudanca:MSC INSA:data_deadline'],
    'gate aberto há mais de 24 h, mudança < 1 h, armador e navio encerrado ficam de fora',
  );
  assert.equal(gerarEventos(navios, [], { agora: AGORA, filtro: { terminal: 'embraport' } }).length, 0, 'filtro ALERTA_FILTRO');
});

test('e-mail com assunto e seções', () => {
  const e = gerarEventos(navios, [mud('MSC INSA', 'NA642R', 'btp', 'data_deadline', f(-4), f(20))], { agora: AGORA });
  const m = montarEmail(e, { url: 'https://portal-de-navios.onrender.com' });
  assert.equal(m.assunto, 'Portal de Navios: 1 deadline em 24 h · 1 gate aberto · 1 data mudou');
  assert.match(m.html, /Deadline nas próximas 24 horas/);
  assert.match(m.html, /adiou \+24 h/);
  assert.match(m.html, /Abrir o painel/);
  assert.match(m.texto, /MSC INSA/);
});

function envioFalso(falhas = 0) {
  const enviados = [];
  return {
    provedor: 'teste',
    para: ['joao.pedro@costalog.com.br'],
    enviados,
    async enviar(email) {
      if (falhas-- > 0) throw new Error('HTTP 500');
      enviados.push(email);
      return `id${enviados.length}`;
    },
  };
}

test('não repete alerta, junta num e-mail e tenta de novo se falhar', async () => {
  const envio = envioFalso(1);
  const a = criarAlertas({ envio, memoria: memoriaSimples(), persistente: true, agora: () => AGORA, log: () => {} });
  assert.equal((await a.avaliar(navios, [])).length, 2);
  assert.equal(await a.despachar(), null, 'primeira tentativa falha');
  assert.match(a.estado().ultimoErro.mensagem, /500/);
  assert.equal(a.estado().pendentes.length, 2, 'fila mantida');
  assert.equal((await a.avaliar(navios, [])).length, 0, 'não duplica na fila');
  const r = await a.despachar();
  assert.equal(r.eventos, 2);
  assert.equal(envio.enviados.length, 1);
  assert.equal((await a.avaliar(navios, [])).length, 0, 'já enviado não volta');
  assert.equal(await a.despachar(), null, 'nada pendente, nada enviado');
});

test('sem banco, a primeira consulta vira base (não repete a cada reinício)', async () => {
  const envio = envioFalso();
  const a = criarAlertas({ envio, memoria: memoriaSimples(), persistente: false, agora: () => AGORA, log: () => {} });
  assert.equal((await a.avaliar(navios, [])).length, 0);
  const mudou = [mud('MSC INSA', 'NA642R', 'btp', 'data_deadline', f(-4), f(20))];
  assert.equal((await a.avaliar(navios, mudou)).length, 1, 'mudanças continuam chegando');
});

test('memória gravada evita repetir depois de reiniciar', async () => {
  const memoria = memoriaSimples();
  const a = criarAlertas({ envio: envioFalso(), memoria, persistente: true, agora: () => AGORA, log: () => {} });
  await a.avaliar(navios, []);
  await a.despachar();
  const b = criarAlertas({ envio: envioFalso(), memoria, persistente: true, agora: () => AGORA, log: () => {} });
  assert.equal((await b.avaliar(navios, [])).length, 0);
});

test('Resend e Brevo pela API HTTPS', async () => {
  const chamadas = [];
  const f2 = async (url, o) => {
    chamadas.push({ url, headers: o.headers, corpo: JSON.parse(o.body) });
    return new Response(JSON.stringify({ id: 'r1', messageId: 'b1' }), { status: 200 });
  };
  assert.equal(criarEnvio({ para: 'x@y.com' }), null, 'sem chave = desligado');
  const resend = criarEnvio({ resendKey: 're_123', para: 'joao.pedro@costalog.com.br', fetch: f2 });
  assert.equal(await resend.enviar({ assunto: 'A', html: '<p>h</p>', texto: 't' }), 'r1');
  assert.equal(chamadas[0].url, 'https://api.resend.com/emails');
  assert.equal(chamadas[0].headers.authorization, 'Bearer re_123');
  assert.deepEqual(chamadas[0].corpo.to, ['joao.pedro@costalog.com.br']);
  assert.match(chamadas[0].corpo.from, /onboarding@resend\.dev/);

  assert.throws(() => criarEnvio({ brevoKey: 'k', para: 'a@b.com' }), /ALERTA_DE/);
  const brevo = criarEnvio({ brevoKey: 'k', de: 'Portal <portal@costalog.com.br>', para: 'a@b.com; c@d.com', fetch: f2 });
  await brevo.enviar({ assunto: 'A', html: 'h', texto: 't' });
  assert.equal(chamadas[1].headers['api-key'], 'k');
  assert.deepEqual(chamadas[1].corpo.sender, { name: 'Portal', email: 'portal@costalog.com.br' });
  assert.deepEqual(chamadas[1].corpo.to, [{ email: 'a@b.com' }, { email: 'c@d.com' }]);

  const erro = criarEnvio({ resendKey: 'x', para: 'a@b.com', fetch: async () => new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 }) });
  await assert.rejects(erro.enviar({ assunto: 'A', html: 'h', texto: 't' }), /401: Invalid API key/);
});

'use strict';

// Alertas por e-mail.
//
// A cada consulta ao DSS, três regras geram eventos:
//   deadline  deadline nas próximas ALERTA_DEADLINE_HORAS (24 h)
//   gate      gate dry ou reefer abriu (abertura nas últimas 24 h)
//   mudanca   uma data importante mudou (deadline, chegada, atracação, abertura de gate, saída, liberações),
//             com diferença de pelo menos ALERTA_MUDANCA_MIN_HORAS (1 h)
// Cada evento tem um id; o mesmo evento nunca é enviado duas vezes (com DATABASE_URL, nem depois de reiniciar).
// Os eventos se acumulam e saem num só e-mail a cada ALERTA_MINUTOS (15 min).
//
// O plano gratuito do Render bloqueia SMTP, então o envio é por API HTTPS: Resend ou Brevo.

const { filtrar } = require('./dss');
const { chaveDe, rotuloCampo } = require('./historico');

const HORA = 36e5;
const CAMPOS_MUDANCA = [
  'data_deadline',
  'data_prev_chegada',
  'data_prev_atracacao',
  'data_atracacao',
  'data_prev_abertura_gate',
  'data_prev_saida',
  'data_prev_lib_dry',
  'data_lib_dry',
  'data_prev_lib_reefer',
  'data_lib_reefer',
];
const TERMINAL = { btp: 'BTP', santos_brasil: 'Santos Brasil', embraport: 'Embraport (DPW)' };

const dssMs = (v) => (v ? Date.parse(`${String(v).replace(' ', 'T')}Z`) : null);
const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const data = (ms) => (ms === null || ms === undefined || Number.isNaN(ms) ? 'sem data' : fmt.format(new Date(ms)).replace(',', ''));
const esc = (v) => String(v ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function diferenca(ms) {
  const a = Math.abs(ms) / HORA;
  const t = a < 1 ? `${Math.round(a * 60)} min` : a < 48 ? `${Math.round(a)} h` : `${(a / 24).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dias`;
  return `${ms > 0 ? '+' : '−'}${t}`;
}

// ------------------------------------------------------------------ regras
/** Eventos atuais a partir dos navios normalizados e das mudanças da última consulta. */
function gerarEventos(navios, mudancas, { agora = Date.now(), filtro = {}, deadlineHoras = 24, mudancaMinHoras = 1 } = {}) {
  const ativos = filtrar(navios, filtro, agora).filter((n) => n.situacao.navio !== 'encerrado');
  const porChave = new Map(ativos.map((n) => [chaveDe(n), n]));
  const eventos = [];
  const base = (n) => ({ chave: chaveDe(n), navio: n.navio, viagem: n.viagem, armador: n.armador, terminal: n.terminal });

  for (const n of ativos) {
    const dl = n.datas.deadline ? Date.parse(n.datas.deadline) : null;
    if (dl && dl > agora && dl <= agora + deadlineHoras * HORA) {
      eventos.push({ id: `deadline|${chaveDe(n)}|${n.datas.deadline}`, tipo: 'deadline', ...base(n), quando: dl, gate: n.situacao.gate });
    }
    for (const [tipo, sit, prev, real] of [
      ['dry', n.situacao.gate, n.datas.prevAberturaGate, n.datas.aberturaGate],
      ['reefer', n.situacao.gateReefer, n.datas.prevAberturaGateReefer, n.datas.aberturaGateReefer],
    ]) {
      const abertura = real || prev;
      if (sit === 'aberto' && abertura && Date.parse(abertura) >= agora - 24 * HORA) {
        eventos.push({ id: `gate|${chaveDe(n)}|${tipo}|${abertura}`, tipo: 'gate', ...base(n), gateTipo: tipo, quando: Date.parse(abertura), confirmado: Boolean(real), deadline: dl });
      }
    }
  }

  for (const m of mudancas) {
    if (!CAMPOS_MUDANCA.includes(m.campo)) continue;
    const n = porChave.get(m.chave);
    if (!n) continue;
    const de = dssMs(m.de);
    const para = dssMs(m.para);
    if (de && para && Math.abs(para - de) < mudancaMinHoras * HORA) continue;
    eventos.push({ id: `mudanca|${m.chave}|${m.campo}|${m.em}`, tipo: 'mudanca', ...base(n), campo: m.campo, rotulo: rotuloCampo(m.campo, m.terminal), de, para, em: m.em });
  }
  return eventos;
}

// ------------------------------------------------------------------ e-mail
function montarEmail(eventos, { url = '' } = {}) {
  const deadlines = eventos.filter((e) => e.tipo === 'deadline').sort((a, b) => a.quando - b.quando);
  const gates = eventos.filter((e) => e.tipo === 'gate').sort((a, b) => a.quando - b.quando);
  const mudancas = eventos.filter((e) => e.tipo === 'mudanca').sort((a, b) => a.navio.localeCompare(b.navio) || String(a.em).localeCompare(String(b.em)));
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const partes = [
    deadlines.length && plural(deadlines.length, 'deadline em 24 h', 'deadlines em 24 h'),
    gates.length && plural(gates.length, 'gate aberto', 'gates abertos'),
    mudancas.length && plural(mudancas.length, 'data mudou', 'datas mudaram'),
  ].filter(Boolean);
  const assunto = `Portal de Navios: ${partes.join(' · ')}`;

  const nome = (e) => `<strong>${esc(e.navio)}</strong> <span style="color:#5b6675">v. ${esc(e.viagem)} · ${esc(e.armador)} · ${esc(TERMINAL[e.terminal] || e.terminal)}</span>`;
  const td = 'style="padding:6px 8px;border-bottom:1px solid #dfe3e8;vertical-align:top"';
  const tabela = (titulo, linhas) =>
    linhas.length ? `<h3 style="font-size:15px;margin:18px 0 6px">${titulo}</h3><table style="border-collapse:collapse;width:100%;font-size:14px">${linhas.map((l) => `<tr>${l.map((c) => `<td ${td}>${c}</td>`).join('')}</tr>`).join('')}</table>` : '';
  const agora = Date.now();

  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1c2430;max-width:720px">
  <h2 style="font-size:18px;margin:0 0 4px">Portal de Navios</h2>
  <div style="color:#5b6675;font-size:13px">${esc(partes.join(' · '))} · horários de Brasília</div>
  ${tabela('Deadline nas próximas 24 horas', deadlines.map((e) => [nome(e), `<strong>${data(e.quando)}</strong>`, `faltam ${Math.max(0, Math.round((e.quando - agora) / HORA))} h`]))}
  ${tabela('Gate aberto', gates.map((e) => [nome(e), `gate ${e.gateTipo}`, `${e.confirmado ? 'abriu' : 'previsto para abrir'} ${data(e.quando)}`, e.deadline ? `deadline ${data(e.deadline)}` : '']))}
  ${tabela('Datas que mudaram', mudancas.map((e) => [nome(e), esc(e.rotulo), `<span style="color:#5b6675;text-decoration:line-through">${data(e.de)}</span> → <strong>${data(e.para)}</strong>${e.de && e.para ? ` (${e.para > e.de ? 'adiou' : 'antecipou'} ${diferenca(e.para - e.de)})` : ''}`]))}
  ${url ? `<p style="margin-top:18px"><a href="${esc(url)}" style="color:#0b6e99">Abrir o painel</a></p>` : ''}
  <p style="color:#5b6675;font-size:12px">Alerta automático do Portal de Navios com dados da API do DSS.</p>
</div>`;

  const texto = [
    assunto,
    ...deadlines.map((e) => `Deadline ${data(e.quando)} · ${e.navio} v. ${e.viagem} · ${TERMINAL[e.terminal] || e.terminal}`),
    ...gates.map((e) => `Gate ${e.gateTipo} ${e.confirmado ? 'abriu' : 'previsto'} ${data(e.quando)} · ${e.navio} v. ${e.viagem}`),
    ...mudancas.map((e) => `${e.navio} v. ${e.viagem}: ${e.rotulo} ${data(e.de)} -> ${data(e.para)}`),
    url,
  ].join('\n');
  return { assunto, html, texto };
}

/** Envio pela API do Resend ou do Brevo (HTTPS; o Render gratuito bloqueia SMTP). */
function criarEnvio({ resendKey, brevoKey, de, para, fetch: f = globalThis.fetch }) {
  const destinos = String(para || '').split(/[,;\s]+/).filter(Boolean);
  if (!destinos.length || !(resendKey || brevoKey)) return null;
  const json = async (res) => {
    const t = await res.text();
    try {
      return JSON.parse(t);
    } catch {
      return { message: t.slice(0, 200) };
    }
  };
  if (resendKey) {
    return {
      provedor: 'Resend',
      para: destinos,
      async enviar({ assunto, html, texto }) {
        const res = await f('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: de || 'Portal de Navios <onboarding@resend.dev>', to: destinos, subject: assunto, html, text: texto }),
          signal: AbortSignal.timeout(15000),
        });
        const corpo = await json(res);
        if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${corpo.message || corpo.error || JSON.stringify(corpo)}`);
        return corpo.id;
      },
    };
  }
  if (!de) throw new Error('Com Brevo, defina ALERTA_DE com o remetente verificado no Brevo.');
  const m = /^(.*)<(.+)>$/.exec(de);
  const remetente = m ? { name: m[1].trim(), email: m[2].trim() } : { name: 'Portal de Navios', email: de.trim() };
  return {
    provedor: 'Brevo',
    para: destinos,
    async enviar({ assunto, html, texto }) {
      const res = await f('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: remetente, to: destinos.map((email) => ({ email })), subject: assunto, htmlContent: html, textContent: texto }),
        signal: AbortSignal.timeout(15000),
      });
      const corpo = await json(res);
      if (!res.ok) throw new Error(`Brevo HTTP ${res.status}: ${corpo.message || JSON.stringify(corpo)}`);
      return corpo.messageId;
    },
  };
}

// ------------------------------------------------------------------ fila e envio
/**
 * `envio`: de criarEnvio (null = alertas desligados). `memoria`: { carregar(): Set de ids, gravar(ids) }.
 * Sem banco, a primeira avaliação só marca o que já existe (para não repetir alertas a cada reinício).
 */
function criarAlertas({ envio, memoria, persistente = false, filtro = {}, deadlineHoras = 24, mudancaMinHoras = 1, url = '', log = console.log, agora = () => Date.now() }) {
  let enviados = new Set();
  let pendentes = new Map();
  let carregado = false;
  let primeira = true;
  let ultimoEnvio = null;
  let ultimoErro = null;
  let ultimoTeste = 0;
  const historicoEnvios = [];

  async function iniciar() {
    if (carregado) return;
    enviados = new Set(await memoria.carregar());
    carregado = true;
  }

  /** Avalia uma consulta: novos eventos vão para a fila. */
  async function avaliar(navios, mudancas) {
    if (!envio) return []; // desligados: não acumula fila
    await iniciar();
    const eventos = gerarEventos(navios, mudancas, { agora: agora(), filtro, deadlineHoras, mudancaMinHoras }).filter((e) => !enviados.has(e.id) && !pendentes.has(e.id));
    if (primeira && !persistente) {
      // Sem banco não há como saber o que já foi enviado antes do reinício: o que existe agora vira base.
      // Mudanças de datas não entram aqui (são sempre novas).
      const base = eventos.filter((e) => e.tipo !== 'mudanca');
      base.forEach((e) => enviados.add(e.id));
      await memoria.gravar(base.map((e) => e.id));
      eventos.splice(0, eventos.length, ...eventos.filter((e) => e.tipo === 'mudanca'));
    }
    primeira = false;
    for (const e of eventos) pendentes.set(e.id, e);
    return eventos;
  }

  /** Envia tudo o que está na fila num e-mail só. Se falhar, a fila fica para a próxima vez. */
  async function despachar() {
    if (!envio || !pendentes.size) return null;
    const lote = [...pendentes.values()];
    const email = montarEmail(lote, { url });
    try {
      const id = await envio.enviar(email);
      lote.forEach((e) => {
        pendentes.delete(e.id);
        enviados.add(e.id);
      });
      await memoria.gravar(lote.map((e) => e.id));
      ultimoEnvio = { em: new Date(agora()).toISOString(), assunto: email.assunto, eventos: lote.length, id };
      ultimoErro = null;
      historicoEnvios.unshift(ultimoEnvio);
      historicoEnvios.splice(30);
      log(`[alertas] e-mail enviado: ${email.assunto}`);
      return ultimoEnvio;
    } catch (e) {
      ultimoErro = { em: new Date(agora()).toISOString(), mensagem: e.message };
      log(`[alertas] falha no envio: ${e.message}`);
      return null;
    }
  }

  /** E-mail de teste (no máximo um a cada 10 min). */
  async function testar() {
    if (!envio) throw new Error('Alertas desligados: defina RESEND_API_KEY (ou BREVO_API_KEY) e ALERTA_PARA.');
    if (agora() - ultimoTeste < 10 * 60e3) throw new Error('Já foi enviado um teste nos últimos 10 minutos.');
    ultimoTeste = agora();
    const assunto = 'Portal de Navios: teste de alerta';
    await envio.enviar({
      assunto,
      html: `<div style="font-family:Segoe UI,Arial,sans-serif"><h2 style="font-size:18px">Portal de Navios</h2><p>Os alertas por e-mail estão funcionando. Você vai receber, a cada consulta com novidades, os deadlines das próximas ${deadlineHoras} h, os gates que abriram e as datas que mudaram.</p>${url ? `<p><a href="${esc(url)}">Abrir o painel</a></p>` : ''}</div>`,
      texto: `Os alertas por e-mail do Portal de Navios estão funcionando. ${url}`,
    });
    return { enviado: true, para: envio.para, provedor: envio.provedor };
  }

  function estado() {
    return {
      ativo: Boolean(envio),
      provedor: envio?.provedor || null,
      para: envio?.para || [],
      regras: { deadlineHoras, mudancaMinHoras, filtro, camposMudanca: CAMPOS_MUDANCA },
      memoria: persistente ? 'postgres' : 'memoria',
      pendentes: [...pendentes.values()].map(({ id, tipo, navio, viagem, terminal }) => ({ id, tipo, navio, viagem, terminal })),
      ultimoEnvio,
      ultimoErro,
      envios: historicoEnvios,
    };
  }

  return { avaliar, despachar, testar, estado };
}

/** Memória de alertas já enviados (Set em memória; o histórico com PostgreSQL fornece a versão gravada). */
function memoriaSimples() {
  const ids = new Set();
  return { carregar: async () => ids, gravar: async (novos) => novos.forEach((i) => ids.add(i)) };
}

module.exports = { criarAlertas, criarEnvio, gerarEventos, montarEmail, memoriaSimples, CAMPOS_MUDANCA };

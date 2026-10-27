'use strict';

// Cliente da API Portal de Navios do DSS (TMS, módulo tms_integr_portal_navios).
//
//   GET {DSS_URL}  (ex.: https://costalog.dssinformatica.com.br/wsdss/navios/listarNavios)
//   Authorization: Basic usuário:senha do DSS
//
// Resposta: { status, apiVersion, mensagemErro, timezone, qtd_registros, registros[] } com o mesmo código no HTTP
// (200 ok, 400 validação, 401 autenticação, 403 cliente sem o módulo, 500 erro no TMS).
// Cada registro: navio, nro_viagem, armador, terminal (btp | santos_brasil | embraport), timezone e 11 datas em UTC
// no formato "AAAA-MM-DD HH:MM:SS". Todos os campos são aproveitados abaixo.

const HORA = 3600e3;

class ErroDss extends Error {
  constructor(mensagem, status, detalhes) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes;
  }
}

/** "2024-07-20 18:00:00" (UTC) -> "2024-07-20T18:00:00.000Z"; vazio ou inválido -> null. */
function dataUtc(valor) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/.exec(String(valor ?? '').trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3] || ':00'}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const horas = (depois, antes) => (depois && antes ? Math.round(((Date.parse(depois) - Date.parse(antes)) / HORA) * 10) / 10 : null);

/** Situação de uma liberação de importação (dry ou reefer). */
const liberacao = (prev, real, agora) =>
  real ? 'liberado' : !prev ? 'sem_dado' : Date.parse(prev) < agora ? 'atrasado' : 'previsto';

/** Converte um registro do DSS e calcula as situações a partir das datas. */
function normalizar(r, agora = Date.now()) {
  const d = {
    prevChegada: dataUtc(r.data_prev_chegada),
    prevAtracacao: dataUtc(r.data_prev_atracacao),
    atracacao: dataUtc(r.data_atracacao),
    prevSaida: dataUtc(r.data_prev_saida),
    prevAberturaGate: dataUtc(r.data_prev_abertura_gate),
    aberturaGate: dataUtc(r.data_abertura_gate),
    deadline: dataUtc(r.data_deadline),
    prevLiberacaoDry: dataUtc(r.data_prev_lib_dry),
    liberacaoDry: dataUtc(r.data_lib_dry),
    prevLiberacaoReefer: dataUtc(r.data_prev_lib_reefer),
    liberacaoReefer: dataUtc(r.data_lib_reefer),
  };
  const antes = (iso) => iso && Date.parse(iso) <= agora;

  // Navio: previsto -> atracacao_atrasada -> atracado -> encerrado (saída prevista já passou)
  let navio = 'previsto';
  if (d.atracacao) navio = antes(d.prevSaida) ? 'encerrado' : 'atracado';
  else if (antes(d.prevAtracacao)) navio = 'atracacao_atrasada';

  // Gate (entrada de contêineres de exportação): aguardando -> aberto -> encerrado no deadline
  const abertura = d.aberturaGate || d.prevAberturaGate;
  let gate = 'sem_dado';
  if (antes(d.deadline)) gate = 'encerrado';
  else if (d.aberturaGate || antes(abertura)) gate = 'aberto';
  else if (abertura || d.deadline) gate = 'aguardando';

  return {
    navio: String(r.navio ?? '').trim() || null,
    viagem: String(r.nro_viagem ?? '').trim() || null,
    armador: String(r.armador ?? '').trim() || null,
    terminal: String(r.terminal ?? '').trim() || null,
    timezone: r.timezone || 'UTC',
    datas: d,
    situacao: {
      navio,
      gate,
      dry: liberacao(d.prevLiberacaoDry, d.liberacaoDry, agora),
      reefer: liberacao(d.prevLiberacaoReefer, d.liberacaoReefer, agora),
    },
    // Horas: positivo = real depois do previsto (atraso) / tempo que falta
    horas: {
      atrasoAtracacao: horas(d.atracacao, d.prevAtracacao),
      atrasoAberturaGate: horas(d.aberturaGate, d.prevAberturaGate),
      atrasoLiberacaoDry: horas(d.liberacaoDry, d.prevLiberacaoDry),
      atrasoLiberacaoReefer: horas(d.liberacaoReefer, d.prevLiberacaoReefer),
      ateDeadline: gate === 'encerrado' ? null : horas(d.deadline, new Date(agora).toISOString()),
      janelaGate: horas(d.deadline, abertura),
      estadia: horas(d.prevSaida, d.atracacao || d.prevAtracacao),
    },
    referencia: d.atracacao || d.prevAtracacao || d.prevChegada || d.deadline,
  };
}

function criarCliente({ url, usuario = '', senha = '', token = '', timeoutMs = 15000, cacheSegundos = 60, fetch: f = globalThis.fetch }) {
  let cache = null; // { em, corpo }
  let emAndamento = null; // consulta em curso, compartilhada por pedidos simultâneos

  function requisicao() {
    const u = new URL(url);
    // Usuário e senha também podem vir na URL (https://usuario:senha@host/...).
    const user = usuario || decodeURIComponent(u.username);
    const pass = senha || decodeURIComponent(u.password);
    u.username = '';
    u.password = '';
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    else if (user) headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    return { u, headers };
  }

  async function consultar() {
    const { u, headers } = requisicao();
    let res;
    try {
      res = await f(u, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new ErroDss(`DSS inacessível (${e.name === 'TimeoutError' ? `sem resposta em ${timeoutMs} ms` : e.message}).`, 504);
    }
    const texto = await res.text();
    let corpo = null;
    try {
      corpo = JSON.parse(texto);
    } catch {
      /* não é JSON */
    }
    const msg = corpo?.mensagemErro || (corpo ? '' : texto.replace(/\s+/g, ' ').slice(0, 120));
    if (res.status === 200 && Array.isArray(corpo?.registros)) return corpo;
    const motivo = {
      400: 'requisição recusada',
      401: 'usuário ou senha inválidos (confira DSS_USUARIO e DSS_SENHA)',
      403: 'cliente sem o módulo tms_integr_portal_navios habilitado',
      500: 'erro no TMS',
    }[res.status] || `HTTP ${res.status}${corpo ? '' : ', resposta não é JSON (confira DSS_URL)'}`;
    throw new ErroDss(`DSS: ${motivo}${msg ? ` – ${msg}` : ''}`, 502, corpo || undefined);
  }

  /** Atracações normalizadas. Usa cache curto e, se o DSS falhar, devolve o último resultado bom com aviso. */
  async function listar({ forcar = false } = {}) {
    const agora = Date.now();
    let aviso = null;
    if (forcar || !cache || agora - cache.em > cacheSegundos * 1000) {
      try {
        emAndamento ||= consultar().finally(() => {
          emAndamento = null;
        });
        cache = { em: agora, corpo: await emAndamento };
      } catch (e) {
        if (!cache) throw e;
        aviso = `${e.message}. Mostrando a última consulta bem-sucedida.`;
      }
    }
    const { corpo, em } = cache;
    return {
      consultadoEm: new Date(em).toISOString(),
      aviso,
      apiVersion: corpo.apiVersion,
      timezone: corpo.timezone || 'UTC',
      qtdRegistros: corpo.qtd_registros ?? corpo.registros.length,
      registros: corpo.registros.map((r) => normalizar(r, agora)),
      bruto: corpo,
    };
  }

  return { listar, consultar };
}

// ------------------------------------------------------------------ filtros e resumo
const sem = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Filtros: terminal, armador, navio (contém), viagem, situacao (do navio), gate, de/ate (data de referência). */
function filtrar(registros, q = {}) {
  const de = q.de ? Date.parse(q.de) : null;
  const ate = q.ate ? Date.parse(q.ate) : null;
  const lista = (v) => (v ? String(v).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : null);
  const terminais = lista(q.terminal);
  const situacoes = lista(q.situacao);
  const gates = lista(q.gate);
  return registros.filter((r) => {
    if (terminais && !terminais.includes(String(r.terminal).toLowerCase())) return false;
    if (situacoes && !situacoes.includes(r.situacao.navio)) return false;
    if (gates && !gates.includes(r.situacao.gate)) return false;
    if (q.armador && sem(r.armador) !== sem(q.armador)) return false;
    if (q.navio && !sem(r.navio).includes(sem(q.navio))) return false;
    if (q.viagem && sem(r.viagem) !== sem(q.viagem)) return false;
    const ref = r.referencia ? Date.parse(r.referencia) : NaN;
    if (de && !(ref >= de)) return false;
    if (ate && !(ref <= ate)) return false;
    return true;
  });
}

function contar(registros, chave) {
  return registros.reduce((acc, r) => ((acc[chave(r)] = (acc[chave(r)] || 0) + 1), acc), {});
}

/** Painel: contagens e listas do que exige atenção nas próximas `horas`. */
function resumir(registros, { horas: janela = 48, agora = Date.now() } = {}) {
  const limite = agora + janela * HORA;
  const ate = (iso) => iso && Date.parse(iso) > agora && Date.parse(iso) <= limite;
  const curto = (r, extra) => ({ navio: r.navio, viagem: r.viagem, armador: r.armador, terminal: r.terminal, ...extra });
  const porData = (campo) => (a, b) => String(a[campo]).localeCompare(String(b[campo]));
  return {
    total: registros.length,
    porTerminal: contar(registros, (r) => r.terminal || 'sem_terminal'),
    porArmador: contar(registros, (r) => r.armador || 'sem_armador'),
    porSituacao: contar(registros, (r) => r.situacao.navio),
    porGate: contar(registros, (r) => r.situacao.gate),
    proximasHoras: janela,
    chegadas: registros.filter((r) => ate(r.datas.prevChegada) && !r.datas.atracacao).map((r) => curto(r, { prevChegada: r.datas.prevChegada })).sort(porData('prevChegada')),
    atracacoes: registros.filter((r) => ate(r.datas.prevAtracacao) && !r.datas.atracacao).map((r) => curto(r, { prevAtracacao: r.datas.prevAtracacao })).sort(porData('prevAtracacao')),
    deadlines: registros.filter((r) => r.situacao.gate === 'aberto' && ate(r.datas.deadline)).map((r) => curto(r, { deadline: r.datas.deadline, horasRestantes: r.horas.ateDeadline })).sort(porData('deadline')),
    aberturasGate: registros.filter((r) => r.situacao.gate === 'aguardando' && ate(r.datas.prevAberturaGate)).map((r) => curto(r, { prevAberturaGate: r.datas.prevAberturaGate })).sort(porData('prevAberturaGate')),
    liberacoes: registros
      .flatMap((r) => [
        !r.datas.liberacaoDry && ate(r.datas.prevLiberacaoDry) ? curto(r, { tipo: 'dry', prevista: r.datas.prevLiberacaoDry }) : null,
        !r.datas.liberacaoReefer && ate(r.datas.prevLiberacaoReefer) ? curto(r, { tipo: 'reefer', prevista: r.datas.prevLiberacaoReefer }) : null,
      ])
      .filter(Boolean)
      .sort(porData('prevista')),
    atrasados: registros.filter((r) => r.situacao.navio === 'atracacao_atrasada' || r.situacao.dry === 'atrasado' || r.situacao.reefer === 'atrasado').map((r) => curto(r, { situacao: r.situacao })),
  };
}

module.exports = { criarCliente, normalizar, filtrar, resumir, dataUtc, ErroDss };

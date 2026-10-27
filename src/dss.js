'use strict';

// Cliente da API Portal de Navios do DSS (TMS, módulo tms_integr_portal_navios).
//
//   GET {DSS_URL}  (ex.: https://costalog.dssinformatica.com.br/wsdss/navios/listarNavios)
//   Authorization: Basic usuário:senha do DSS
//
// Resposta: { status, apiVersion, mensagemErro, timezone, qtd_registros, registros[] } com o mesmo código no HTTP
// (200 ok, 400 validação, 401 autenticação, 403 cliente sem o módulo, 500 erro no TMS).
// Cada registro: navio, nro_viagem, armador, terminal (btp | santos_brasil | embraport), timezone e 11 datas em UTC
// no formato "AAAA-MM-DD HH:MM:SS".
//
// CORREÇÕES DE LEITURA (observadas nos dados reais de out/2026; cada uma vira um item em `qualidade`):
//   1. Data "real" no futuro (abertura de gate da BTP, atracação da Embraport) é na verdade previsão.
//   2. BTP e Santos Brasil gravam a ABERTURA DE GATE REEFER em data_lib_reefer (igual à abertura de gate dry).
//   3. data_prev_atracacao nunca vem preenchida: a espera pela atracação é medida pela chegada prevista.
//   4. Santos Brasil grava a viagem no campo armador: o armador é deduzido (mesmo navio em outro terminal
//      ou prefixo do nome do navio).
//   5. Datas a mais de 1 ano de hoje (ex.: 2044) são descartadas como suspeitas.

const HORA = 3600e3;
const DIA = 24 * HORA;
const LIMITE_DATA = 365 * DIA;

// Terminais que gravam a abertura de gate reefer em data_lib_reefer.
const REEFER_E_GATE = new Set(['btp', 'santos_brasil']);

// Prefixo do nome do navio -> código de armador usado pelo DSS.
const PREFIXOS_ARMADOR = [
  [/^MSC\b/, 'MSC'],
  [/^MAERSK\b/, 'MAE'],
  [/^CMA CGM\b/, 'CMA'],
  [/^COSCO\b/, 'COS'],
  [/^ONE\b/, 'ONE'],
  [/^(HMM|HYUNDAI)\b/, 'HMM'],
  [/^EVER\b/, 'EMC'],
  [/^(MERCOSUL|ALIANCA)\b/, 'ALI'],
];

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
const texto = (v) => String(v ?? '').trim() || null;
const nomeChave = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const armadorValido = (a, viagem) => Boolean(a) && /^[A-Z]{2,4}$/.test(a) && a !== viagem;

/**
 * Contexto tirado da resposta inteira, usado nas correções:
 *   - armadorPorNavio: armador válido do mesmo navio em qualquer terminal;
 *   - terminaisComAtracacao: terminais que informam atracação em algum registro.
 */
function criarContexto(registros) {
  const armadorPorNavio = new Map();
  const terminaisComAtracacao = new Set();
  for (const r of registros) {
    const a = texto(r.armador);
    if (armadorValido(a, texto(r.nro_viagem))) armadorPorNavio.set(nomeChave(r.navio), a);
    if (dataUtc(r.data_atracacao)) terminaisComAtracacao.add(texto(r.terminal));
  }
  return { armadorPorNavio, terminaisComAtracacao };
}

function deduzirArmador(navio, contexto) {
  const doContexto = contexto.armadorPorNavio.get(nomeChave(navio));
  if (doContexto) return { armador: doContexto, origem: 'mesmo navio em outro registro' };
  const nome = String(navio || '').toUpperCase();
  const prefixo = PREFIXOS_ARMADOR.find(([re]) => re.test(nome));
  return prefixo ? { armador: prefixo[1], origem: 'nome do navio' } : { armador: null, origem: null };
}

/** Situação de uma liberação de importação (dry ou reefer). */
const liberacao = (prev, real, agora) =>
  real ? 'liberado' : !prev ? 'sem_dado' : Date.parse(prev) < agora ? 'atrasado' : 'previsto';

/** Situação de um gate: aguardando -> aberto -> encerrado no deadline. */
function situacaoGate(prev, real, deadline, agora) {
  const abertura = real || prev;
  if (deadline && Date.parse(deadline) <= agora) return 'encerrado';
  if (abertura && Date.parse(abertura) <= agora) return 'aberto';
  if (abertura || deadline) return 'aguardando';
  return 'sem_dado';
}

/** Converte um registro do DSS, aplica as correções de leitura e calcula as situações. */
function normalizar(r, agora = Date.now(), contexto = criarContexto([r])) {
  const terminal = texto(r.terminal);
  const viagem = texto(r.nro_viagem);
  const qualidade = [];

  // Datas brutas; descarta as que estão a mais de 1 ano de hoje (correção 5).
  const suspeitas = {};
  const ler = (campo) => {
    const iso = dataUtc(r[campo]);
    if (iso && Math.abs(Date.parse(iso) - agora) > LIMITE_DATA) {
      suspeitas[campo] = iso;
      qualidade.push({ campo, problema: 'data_suspeita', valor: iso });
      return null;
    }
    return iso;
  };
  const d = {
    prevChegada: ler('data_prev_chegada'),
    prevAtracacao: ler('data_prev_atracacao'),
    atracacao: ler('data_atracacao'),
    prevSaida: ler('data_prev_saida'),
    prevAberturaGate: ler('data_prev_abertura_gate'),
    aberturaGate: ler('data_abertura_gate'),
    prevAberturaGateReefer: null,
    aberturaGateReefer: null,
    deadline: ler('data_deadline'),
    prevLiberacaoDry: ler('data_prev_lib_dry'),
    liberacaoDry: ler('data_lib_dry'),
    prevLiberacaoReefer: ler('data_prev_lib_reefer'),
    liberacaoReefer: ler('data_lib_reefer'),
  };

  // Correção 2: liberação reefer que é, na verdade, abertura de gate reefer.
  const reeferIgualGate = d.liberacaoReefer && d.liberacaoReefer === d.aberturaGate;
  if ((REEFER_E_GATE.has(terminal) || reeferIgualGate) && (d.liberacaoReefer || d.prevLiberacaoReefer)) {
    d.aberturaGateReefer = d.liberacaoReefer;
    d.prevAberturaGateReefer = d.prevLiberacaoReefer;
    d.liberacaoReefer = null;
    d.prevLiberacaoReefer = null;
    qualidade.push({ campo: 'data_lib_reefer', problema: 'reefer_e_abertura_de_gate' });
  }

  // Correção 1: data "real" no futuro vira previsão.
  for (const [real, prev, campo] of [
    ['atracacao', 'prevAtracacao', 'data_atracacao'],
    ['aberturaGate', 'prevAberturaGate', 'data_abertura_gate'],
    ['aberturaGateReefer', 'prevAberturaGateReefer', 'data_lib_reefer'],
    ['liberacaoDry', 'prevLiberacaoDry', 'data_lib_dry'],
    ['liberacaoReefer', 'prevLiberacaoReefer', 'data_lib_reefer'],
  ]) {
    if (d[real] && Date.parse(d[real]) > agora) {
      d[prev] = d[prev] || d[real];
      d[real] = null;
      qualidade.push({ campo, problema: 'data_real_no_futuro' });
    }
  }

  // Correção 4: armador.
  let armador = texto(r.armador);
  let armadorOrigem = 'dss';
  if (!armadorValido(armador, viagem)) {
    qualidade.push({ campo: 'armador', problema: armador === viagem ? 'armador_igual_viagem' : 'armador_invalido', valor: armador });
    const deduzido = deduzirArmador(r.navio, contexto);
    armador = deduzido.armador;
    armadorOrigem = deduzido.origem;
  }

  // Correção 3: data_prev_atracacao não vem; o navio passa a "aguardar atracação" quando a chegada prevista
  // (ou, na falta dela, a atracação prevista) já passou e ele ainda não atracou.
  const passou = (iso) => iso && Date.parse(iso) <= agora;
  const esperadoEm = [d.prevChegada, d.prevAtracacao].find(passou) || null;
  let navio = 'previsto';
  if (passou(d.prevSaida)) {
    // Saída prevista já passou: o navio saiu, mesmo que o terminal não tenha informado a atracação
    // (a BTP só informa atracação em parte dos navios).
    navio = 'encerrado';
    if (!d.atracacao) qualidade.push({ campo: 'data_atracacao', problema: 'saida_sem_atracacao' });
  } else if (d.atracacao) navio = 'atracado';
  else if (esperadoEm) navio = contexto.terminaisComAtracacao.has(terminal) ? 'aguardando_atracacao' : 'chegada_passou';
  if (!d.prevAtracacao) qualidade.push({ campo: 'data_prev_atracacao', problema: 'campo_vazio' });

  const gate = situacaoGate(d.prevAberturaGate, d.aberturaGate, d.deadline, agora);
  const gateReefer = d.aberturaGateReefer || d.prevAberturaGateReefer ? situacaoGate(d.prevAberturaGateReefer, d.aberturaGateReefer, d.deadline, agora) : 'sem_dado';
  const agoraIso = new Date(agora).toISOString();

  return {
    navio: texto(r.navio),
    viagem,
    armador,
    armadorOrigem: armador ? armadorOrigem : null,
    terminal,
    timezone: r.timezone || 'UTC',
    datas: d,
    situacao: {
      navio,
      gate,
      gateReefer,
      dry: liberacao(d.prevLiberacaoDry, d.liberacaoDry, agora),
      reefer: liberacao(d.prevLiberacaoReefer, d.liberacaoReefer, agora),
    },
    // Horas: positivo = real depois do previsto (atraso) / tempo que falta
    horas: {
      esperaAtracacao: navio === 'aguardando_atracacao' ? horas(agoraIso, esperadoEm) : null,
      atrasoAtracacao: horas(d.atracacao, d.prevAtracacao || d.prevChegada),
      atrasoAberturaGate: horas(d.aberturaGate, d.prevAberturaGate),
      atrasoLiberacaoDry: horas(d.liberacaoDry, d.prevLiberacaoDry),
      atrasoLiberacaoReefer: horas(d.liberacaoReefer, d.prevLiberacaoReefer),
      ateDeadline: gate === 'encerrado' ? null : horas(d.deadline, agoraIso),
      janelaGate: horas(d.deadline, d.aberturaGate || d.prevAberturaGate),
      estadia: horas(d.prevSaida, d.atracacao || d.prevAtracacao),
    },
    referencia: d.atracacao || d.prevAtracacao || d.prevChegada || d.deadline,
    qualidade,
    ...(Object.keys(suspeitas).length ? { datasSuspeitas: suspeitas } : {}),
  };
}

/** Normaliza a resposta inteira (com o contexto que as correções precisam). */
function normalizarTodos(registros, agora = Date.now()) {
  const contexto = criarContexto(registros);
  return registros.map((r) => normalizar(r, agora, contexto));
}

function criarCliente({ url, usuario = '', senha = '', token = '', timeoutMs = 15000, cacheSegundos = 60, intervaloMinimoForcarMs = 15000, fetch: f = globalThis.fetch, aoAtualizar = null }) {
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
    const corpoTexto = await res.text();
    let corpo = null;
    try {
      corpo = JSON.parse(corpoTexto);
    } catch {
      /* não é JSON */
    }
    const msg = corpo?.mensagemErro || (corpo ? '' : corpoTexto.replace(/\s+/g, ' ').slice(0, 120));
    if (res.status === 200 && Array.isArray(corpo?.registros)) return corpo;
    const motivo = {
      400: 'requisição recusada',
      401: 'usuário ou senha inválidos (confira DSS_USUARIO e DSS_SENHA)',
      403: 'cliente sem o módulo tms_integr_portal_navios habilitado',
      500: 'erro no TMS',
    }[res.status] || `HTTP ${res.status}${corpo ? '' : ', resposta não é JSON (confira DSS_URL)'}`;
    throw new ErroDss(`DSS: ${motivo}${msg ? ` – ${msg}` : ''}`, 502, corpo || undefined);
  }

  let emSegundoPlano = false;
  let ultimoErro = null;

  /** Consulta o DSS e guarda o resultado já normalizado (uma vez por consulta, não a cada acesso). */
  function atualizar() {
    emAndamento ||= consultar()
      .then((corpo) => {
        const em = Date.now();
        cache = { em, corpo, registros: normalizarTodos(corpo.registros, em) };
        ultimoErro = null;
        // Gancho para o histórico de mudanças (não atrasa nem derruba a consulta).
        const normalizados = cache.registros;
        if (aoAtualizar) Promise.resolve().then(() => aoAtualizar(corpo.registros, em, normalizados)).catch((e) => console.error('[historico]', e.message));
        return cache;
      })
      .catch((e) => {
        ultimoErro = { em: Date.now(), mensagem: e.message };
        throw e;
      })
      .finally(() => {
        emAndamento = null;
      });
    return emAndamento;
  }

  /**
   * Atracações normalizadas. Com a atualização em segundo plano ligada, devolve sempre o cache (sem esperar o DSS).
   * `forcar` consulta o DSS na hora, mas no máximo a cada `intervaloMinimoForcarMs`. Se o DSS falhar e houver
   * resultado anterior, devolve esse resultado com aviso.
   */
  async function listar({ forcar = false } = {}) {
    const idade = cache ? Date.now() - cache.em : Infinity;
    const vencido = idade > cacheSegundos * 1000 * (emSegundoPlano ? 3 : 1);
    if (!cache || vencido || (forcar && idade >= intervaloMinimoForcarMs)) {
      try {
        await atualizar();
      } catch (e) {
        if (!cache) throw e;
      }
    }
    const { corpo, em, registros } = cache;
    return {
      consultadoEm: new Date(em).toISOString(),
      aviso: ultimoErro ? `${ultimoErro.mensagem}. Mostrando a última consulta bem-sucedida.` : null,
      apiVersion: corpo.apiVersion,
      timezone: corpo.timezone || 'UTC',
      qtdRegistros: corpo.qtd_registros ?? corpo.registros.length,
      registros,
      bruto: corpo,
    };
  }

  /** Liga a consulta periódica ao DSS. Devolve uma função para desligar. */
  function iniciarAtualizacao(intervaloMs = cacheSegundos * 1000, aoFalhar = () => {}) {
    emSegundoPlano = true;
    const rodar = () => atualizar().catch(aoFalhar);
    rodar();
    const timer = setInterval(rodar, intervaloMs);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      emSegundoPlano = false;
    };
  }

  return { listar, consultar, iniciarAtualizacao };
}

// ------------------------------------------------------------------ filtros e resumo
const sem = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Data mais recente de um registro (para descartar registros "fantasma", com tudo no passado). */
function ultimaData(r) {
  return Math.max(...Object.values(r.datas).map((v) => (v ? Date.parse(v) : -Infinity)));
}

/**
 * Filtros: terminal, armador, navio (contém), viagem, situacao (do navio), gate, de/ate (data de referência).
 * `dias=N` é a janela de trabalho: navios até N dias à frente, sem os encerrados (a menos que `encerrados=true`)
 * e sem registros cuja data mais recente ficou mais de 2 dias para trás.
 */
function filtrar(registros, q = {}, agora = Date.now()) {
  const de = q.de ? Date.parse(q.de) : null;
  const ate = q.ate ? Date.parse(q.ate) : null;
  const dias = Number(q.dias) > 0 ? Number(q.dias) : null;
  const comEncerrados = q.encerrados === 'true';
  const lista = (v) => (v ? String(v).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : null);
  const terminais = lista(q.terminal);
  const situacoes = lista(q.situacao);
  const gates = lista(q.gate);
  return registros.filter((r) => {
    if (terminais && !terminais.includes(String(r.terminal).toLowerCase())) return false;
    if (situacoes && !situacoes.includes(r.situacao.navio)) return false;
    if (gates && !gates.includes(r.situacao.gate) && !gates.includes(r.situacao.gateReefer)) return false;
    if (q.armador && sem(r.armador) !== sem(q.armador)) return false;
    if (q.navio && !sem(r.navio).includes(sem(q.navio))) return false;
    if (q.viagem && sem(r.viagem) !== sem(q.viagem)) return false;
    const ref = r.referencia ? Date.parse(r.referencia) : NaN;
    if (de && !(ref >= de)) return false;
    if (ate && !(ref <= ate)) return false;
    if (!comEncerrados && (dias || q.encerrados === 'false') && r.situacao.navio === 'encerrado') return false;
    if (dias) {
      if (!(ref <= agora + dias * DIA)) return false;
      if (ultimaData(r) < agora - 2 * DIA) return false;
    }
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
    porGateReefer: contar(registros, (r) => r.situacao.gateReefer),
    proximasHoras: janela,
    chegadas: registros.filter((r) => ate(r.datas.prevChegada) && !r.datas.atracacao).map((r) => curto(r, { prevChegada: r.datas.prevChegada })).sort(porData('prevChegada')),
    atracacoes: registros.filter((r) => ate(r.datas.prevAtracacao) && !r.datas.atracacao).map((r) => curto(r, { prevAtracacao: r.datas.prevAtracacao })).sort(porData('prevAtracacao')),
    deadlines: registros.filter((r) => (r.situacao.gate === 'aberto' || r.situacao.gateReefer === 'aberto') && ate(r.datas.deadline)).map((r) => curto(r, { deadline: r.datas.deadline, horasRestantes: r.horas.ateDeadline })).sort(porData('deadline')),
    aberturasGate: registros
      .flatMap((r) => [
        r.situacao.gate === 'aguardando' && ate(r.datas.prevAberturaGate) ? curto(r, { tipo: 'dry', prevista: r.datas.prevAberturaGate }) : null,
        r.situacao.gateReefer === 'aguardando' && ate(r.datas.prevAberturaGateReefer) ? curto(r, { tipo: 'reefer', prevista: r.datas.prevAberturaGateReefer }) : null,
      ])
      .filter(Boolean)
      .sort(porData('prevista')),
    liberacoes: registros
      .flatMap((r) => [
        !r.datas.liberacaoDry && ate(r.datas.prevLiberacaoDry) ? curto(r, { tipo: 'dry', prevista: r.datas.prevLiberacaoDry }) : null,
        !r.datas.liberacaoReefer && ate(r.datas.prevLiberacaoReefer) ? curto(r, { tipo: 'reefer', prevista: r.datas.prevLiberacaoReefer }) : null,
      ])
      .filter(Boolean)
      .sort(porData('prevista')),
    aguardandoAtracacao: registros
      .filter((r) => r.situacao.navio === 'aguardando_atracacao')
      .map((r) => curto(r, { esperadoEm: r.datas.prevChegada || r.datas.prevAtracacao, horasDeEspera: r.horas.esperaAtracacao }))
      .sort((a, b) => b.horasDeEspera - a.horasDeEspera),
    atrasados: registros.filter((r) => r.situacao.dry === 'atrasado' || r.situacao.reefer === 'atrasado').map((r) => curto(r, { situacao: r.situacao })),
    qualidade: contar(registros.flatMap((r) => r.qualidade.map((q) => ({ ...q, terminal: r.terminal }))), (q) => `${q.terminal}:${q.problema}`),
  };
}

module.exports = { criarCliente, normalizar, normalizarTodos, criarContexto, filtrar, resumir, dataUtc, ErroDss };

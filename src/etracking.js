'use strict';

// Integração com o eTracking: pronta, mas desligada até existir ETRACKING_URL.
//
// O portal busca a lista de contêineres no eTracking, encontra o navio de cada um (pelo nome do navio e pela
// viagem) e mostra, por navio, quantos contêineres da Costalog estão nele e quantos ainda não entraram no
// terminal. Como o formato da API do eTracking ainda não é conhecido, tudo é configurável por variáveis:
//
//   ETRACKING_URL          endereço que devolve os contêineres (JSON)
//   ETRACKING_METODO       GET (padrão) ou POST
//   ETRACKING_CORPO        corpo JSON do POST, se houver
//   ETRACKING_USUARIO / ETRACKING_SENHA   login Basic, se for o caso
//   ETRACKING_TOKEN        token; vai no cabeçalho ETRACKING_CABECALHO (padrão "Authorization", com "Bearer ")
//   ETRACKING_LISTA        caminho até a lista na resposta, ex.: "dados.conteineres" (vazio = a primeira lista encontrada)
//   ETRACKING_CAMPOS       JSON com o nome de cada campo na resposta, ex.:
//                          {"conteiner":"nr_container","navio":"nm_navio","viagem":"nr_viagem","booking":"nr_booking",
//                           "cliente":"nm_cliente","situacao":"ds_status","entrada":"dt_gate_in","tipo":"tp_container"}
//   ETRACKING_ENTREGUE     expressão (regex) que, na situação, indica contêiner já entregue no terminal
//                          (padrão: gate.?in|entregue|no terminal|embarcado). Uma data em "entrada" também conta.
//   ETRACKING_MINUTOS      intervalo entre consultas (padrão 10)

const so = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const CAMPOS_PADRAO = {
  conteiner: ['conteiner', 'container', 'nr_container', 'numero_container', 'cntr'],
  navio: ['navio', 'nome_navio', 'nm_navio', 'vessel'],
  viagem: ['viagem', 'nro_viagem', 'nr_viagem', 'voyage'],
  booking: ['booking', 'nr_booking'],
  cliente: ['cliente', 'nm_cliente', 'customer'],
  situacao: ['situacao', 'status', 'ds_status'],
  entrada: ['entrada', 'data_entrada', 'dt_gate_in', 'gate_in'],
  tipo: ['tipo', 'tp_container', 'type'],
  terminal: ['terminal'],
};

function ler(obj, caminho) {
  return String(caminho)
    .split('.')
    .filter(Boolean)
    .reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

function acharLista(corpo, caminho) {
  if (caminho) return ler(corpo, caminho);
  if (Array.isArray(corpo)) return corpo;
  for (const v of Object.values(corpo || {})) if (Array.isArray(v)) return v;
  for (const v of Object.values(corpo || {})) if (v && typeof v === 'object') {
    const l = acharLista(v);
    if (Array.isArray(l)) return l;
  }
  return null;
}

/** Converte um item da resposta usando o mapeamento (ou os nomes mais comuns). */
function normalizarConteiner(item, campos, entregue) {
  const valor = (nome) => {
    const c = campos[nome];
    if (c) return ler(item, c);
    const chave = CAMPOS_PADRAO[nome].find((k) => item[k] !== undefined);
    return chave ? item[chave] : undefined;
  };
  const txt = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
  const situacao = txt(valor('situacao'));
  const entrada = txt(valor('entrada'));
  return {
    conteiner: txt(valor('conteiner')),
    navio: txt(valor('navio')),
    viagem: txt(valor('viagem')),
    booking: txt(valor('booking')),
    cliente: txt(valor('cliente')),
    situacao,
    entrada,
    tipo: txt(valor('tipo')),
    terminal: txt(valor('terminal')),
    noTerminal: Boolean(entrada) || (situacao ? entregue.test(situacao) : false),
  };
}

/** Liga cada contêiner a um navio do DSS: navio + viagem; se não achar, só a viagem quando ela for única. */
function cruzar(conteineres, navios) {
  const porNavioViagem = new Map();
  const porViagem = new Map();
  for (const n of navios) {
    porNavioViagem.set(`${so(n.navio)}|${so(n.viagem)}`, n);
    const v = so(n.viagem);
    porViagem.set(v, porViagem.has(v) ? null : n);
  }
  const porChave = new Map();
  const semNavio = [];
  for (const c of conteineres) {
    const n = porNavioViagem.get(`${so(c.navio)}|${so(c.viagem)}`) || (c.viagem ? porViagem.get(so(c.viagem)) : null);
    if (!n) {
      semNavio.push(c);
      continue;
    }
    if (!porChave.has(n.chave)) porChave.set(n.chave, []);
    porChave.get(n.chave).push(c);
  }
  return { porChave, semNavio };
}

function resumoNavio(lista = []) {
  const fora = lista.filter((c) => !c.noTerminal).length;
  return { total: lista.length, noTerminal: lista.length - fora, fora };
}

function criarEtracking({ env = process.env, fetch: f = globalThis.fetch, log = console.log } = {}) {
  const url = env.ETRACKING_URL;
  if (!url) return null;
  let campos = {};
  try {
    campos = env.ETRACKING_CAMPOS ? JSON.parse(env.ETRACKING_CAMPOS) : {};
  } catch {
    log('[etracking] ETRACKING_CAMPOS não é um JSON válido; usando os nomes mais comuns.');
  }
  let entregue = /gate.?in|entregue|no terminal|embarcado/i;
  try {
    if (env.ETRACKING_ENTREGUE) entregue = new RegExp(env.ETRACKING_ENTREGUE, 'i');
  } catch {
    log('[etracking] ETRACKING_ENTREGUE não é uma expressão válida; usando a padrão.');
  }
  let ultimo = { em: null, conteineres: [], erro: null };

  async function consultar() {
    const headers = { accept: 'application/json' };
    if (env.ETRACKING_TOKEN) {
      const cab = env.ETRACKING_CABECALHO || 'Authorization';
      headers[cab.toLowerCase()] = cab.toLowerCase() === 'authorization' && !/^\w+ /.test(env.ETRACKING_TOKEN) ? `Bearer ${env.ETRACKING_TOKEN}` : env.ETRACKING_TOKEN;
    } else if (env.ETRACKING_USUARIO) {
      headers.authorization = `Basic ${Buffer.from(`${env.ETRACKING_USUARIO}:${env.ETRACKING_SENHA || ''}`).toString('base64')}`;
    }
    const metodo = (env.ETRACKING_METODO || 'GET').toUpperCase();
    if (metodo === 'POST') headers['content-type'] = 'application/json';
    const res = await f(url, { method: metodo, headers, body: metodo === 'POST' ? env.ETRACKING_CORPO || '{}' : undefined, signal: AbortSignal.timeout(20000) });
    const texto = await res.text();
    if (!res.ok) throw new Error(`eTracking HTTP ${res.status}: ${texto.slice(0, 160)}`);
    let corpo;
    try {
      corpo = JSON.parse(texto);
    } catch {
      throw new Error('eTracking não devolveu JSON (confira ETRACKING_URL).');
    }
    const lista = acharLista(corpo, env.ETRACKING_LISTA);
    if (!Array.isArray(lista)) throw new Error('Lista de contêineres não encontrada na resposta (confira ETRACKING_LISTA).');
    return lista.map((i) => normalizarConteiner(i, campos, entregue)).filter((c) => c.conteiner || c.booking);
  }

  async function atualizar() {
    try {
      ultimo = { em: new Date().toISOString(), conteineres: await consultar(), erro: null };
    } catch (e) {
      ultimo = { ...ultimo, erro: e.message, erroEm: new Date().toISOString() };
      log(`[etracking] ${e.message}`);
    }
    return ultimo;
  }

  return {
    atualizar,
    iniciar(minutos = Number(env.ETRACKING_MINUTOS) || 10) {
      atualizar();
      setInterval(atualizar, minutos * 60e3).unref();
    },
    /** Contêineres casados com os navios atuais. */
    cruzar(navios) {
      return cruzar(ultimo.conteineres, navios);
    },
    estado(navios = []) {
      const { porChave, semNavio } = cruzar(ultimo.conteineres, navios);
      return {
        configurado: true,
        consultadoEm: ultimo.em,
        erro: ultimo.erro,
        conteineres: ultimo.conteineres.length,
        casados: ultimo.conteineres.length - semNavio.length,
        navios: porChave.size,
        semNavio: semNavio.slice(0, 50).map((c) => ({ conteiner: c.conteiner, navio: c.navio, viagem: c.viagem })),
      };
    },
  };
}

module.exports = { criarEtracking, normalizarConteiner, cruzar, resumoNavio, acharLista };

'use strict';

// Histórico de mudanças das atracações do DSS.
//
// A cada consulta bem-sucedida, cada registro é comparado com a versão anterior do mesmo navio/viagem/terminal,
// campo a campo (as 11 datas e o armador, como vieram do DSS). Só as diferenças são gravadas:
//   { em, chave, terminal, navio, viagem, campo, de, para }
// Também são registrados navios que entram na lista (campo "registro": null -> "novo"), saem ("removido") ou voltam.
//
// Com DATABASE_URL usa PostgreSQL (o estado anterior sobrevive a reinícios); sem ela, guarda em memória.
// As mudanças dos últimos `diasEmMemoria` dias ficam também em memória, para o painel não consultar o banco.

const CAMPOS = [
  'armador',
  'data_prev_chegada',
  'data_prev_atracacao',
  'data_atracacao',
  'data_prev_saida',
  'data_prev_abertura_gate',
  'data_abertura_gate',
  'data_deadline',
  'data_prev_lib_dry',
  'data_lib_dry',
  'data_prev_lib_reefer',
  'data_lib_reefer',
];

const normalizarChave = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const chaveDe = (r) => `${String(r.terminal ?? '').trim().toLowerCase()}|${normalizarChave(r.navio)}|${normalizarChave(r.nro_viagem ?? r.viagem)}`;
const valor = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

/** Diferenças entre o estado anterior (Map chave -> registro bruto) e a consulta atual. */
function compararEstados(anterior, registros, em) {
  const mudancas = [];
  const atual = new Map();
  for (const r of registros) atual.set(chaveDe(r), r);
  const base = (chave, r) => ({ em, chave, terminal: valor(r.terminal), navio: valor(r.navio), viagem: valor(r.nro_viagem) });

  for (const [chave, r] of atual) {
    const antes = anterior.get(chave);
    if (!antes) {
      mudancas.push({ ...base(chave, r), campo: 'registro', de: null, para: 'novo' });
      continue;
    }
    if (antes.__removido) mudancas.push({ ...base(chave, r), campo: 'registro', de: 'removido', para: 'voltou' });
    for (const campo of CAMPOS) {
      const de = valor(antes[campo]);
      const para = valor(r[campo]);
      if (de !== para) mudancas.push({ ...base(chave, r), campo, de, para });
    }
  }
  for (const [chave, r] of anterior) {
    if (!atual.has(chave) && !r.__removido) mudancas.push({ ...base(chave, r), campo: 'registro', de: 'presente', para: 'removido' });
  }
  return { mudancas, atual };
}

function filtrarMudancas(lista, { desde, chave, terminal, navio, campo, limite = 500 } = {}) {
  const t = desde ? Date.parse(desde) : null;
  const n = navio ? normalizarChave(navio) : null;
  return lista
    .filter((m) => (!t || Date.parse(m.em) >= t) && (!chave || m.chave === chave) && (!terminal || m.terminal === terminal) && (!n || normalizarChave(m.navio).includes(n)) && (!campo || m.campo === campo))
    .sort((a, b) => b.em.localeCompare(a.em))
    .slice(0, limite);
}

/** Base comum: estado anterior e mudanças recentes em memória. `persistir` grava no banco (opcional). */
function criarBase({ tipo, diasEmMemoria = 7, carregar = async () => ({ estado: new Map(), recentes: [] }), persistir = async () => {}, buscar = null }) {
  let estado = new Map();
  let recentes = [];
  let primeiraConsulta = true;
  let fila = Promise.resolve();

  return {
    tipo,
    async iniciar() {
      const r = await carregar(diasEmMemoria);
      estado = r.estado;
      recentes = r.recentes;
      primeiraConsulta = estado.size === 0;
    },
    /** Registra uma consulta. Na primeira de todas (sem estado anterior) só guarda a base, sem gerar mudanças. */
    registrar(registros, emMs = Date.now()) {
      // Se a gravação falhar, o estado não avança: as mesmas mudanças são detectadas de novo na próxima consulta.
      fila = fila.catch(() => {}).then(async () => {
        const em = new Date(emMs).toISOString();
        const { mudancas, atual } = compararEstados(estado, registros, em);
        const novas = primeiraConsulta ? [] : mudancas;
        // Navios que saíram continuam no estado, marcados, para detectar se voltarem.
        const proximo = new Map(atual);
        for (const [chave, r] of estado) if (!atual.has(chave)) proximo.set(chave, { ...r, __removido: true });
        await persistir({ mudancas: novas, estado: proximo, anterior: estado, em });
        estado = proximo;
        primeiraConsulta = false;
        const limite = Date.now() - diasEmMemoria * 864e5;
        recentes = recentes.concat(novas).filter((m) => Date.parse(m.em) >= limite);
        return novas;
      });
      return fila;
    },
    /** Mudanças em memória (últimos dias) ou, para períodos maiores, do banco. */
    async listar(filtro = {}) {
      const desdeMs = filtro.desde ? Date.parse(filtro.desde) : 0;
      if (buscar && desdeMs < Date.now() - diasEmMemoria * 864e5) return buscar(filtro);
      return filtrarMudancas(recentes, filtro);
    },
    /** Quantas mudanças cada navio teve desde `desde` (para o selo "mudou" do painel). */
    contarPorChave(desde) {
      const t = Date.parse(desde);
      const contagem = {};
      for (const m of recentes) if (Date.parse(m.em) >= t && m.campo !== 'registro') contagem[m.chave] = (contagem[m.chave] || 0) + 1;
      return contagem;
    },
  };
}

function criarMemoria(opcoes = {}) {
  const ids = new Set();
  const memoriaAlertas = { carregar: async () => [...ids], gravar: async (novos) => novos.forEach((i) => ids.add(i)) };
  return { ...criarBase({ tipo: 'memoria', ...opcoes }), memoriaAlertas };
}

function criarPostgres(url, { diasHistorico = 180, ssl, ...opcoes } = {}) {
  const { Pool } = require('pg');
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  // A URL interna do Render (host "dpg-...") não usa SSL; a externa (*.render.com) exige.
  const pool = new Pool({ connectionString: url, ssl: ssl ?? (host.endsWith('.render.com') ? { rejectUnauthorized: false } : false), max: 3, connectionTimeoutMillis: 10000 });
  pool.on('error', (e) => console.error('[historico] conexão:', e.message));
  const iso = (v) => (v instanceof Date ? v.toISOString() : v);
  const deLinha = (l) => ({ em: iso(l.em), chave: l.chave, terminal: l.terminal, navio: l.navio, viagem: l.viagem, campo: l.campo, de: l.de, para: l.para });

  const base = criarBase({
    tipo: 'postgres',
    ...opcoes,
    async carregar(diasEmMemoria) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS navios_estado (
          chave TEXT PRIMARY KEY, dados JSONB NOT NULL, visto_em TIMESTAMPTZ NOT NULL, removido BOOLEAN NOT NULL DEFAULT FALSE);
        CREATE TABLE IF NOT EXISTS navios_mudancas (
          id BIGSERIAL PRIMARY KEY, em TIMESTAMPTZ NOT NULL, chave TEXT NOT NULL,
          terminal TEXT, navio TEXT, viagem TEXT, campo TEXT NOT NULL, de TEXT, para TEXT);
        CREATE INDEX IF NOT EXISTS idx_mudancas_em ON navios_mudancas (em DESC);
        CREATE INDEX IF NOT EXISTS idx_mudancas_chave ON navios_mudancas (chave, em DESC);
        CREATE TABLE IF NOT EXISTS alertas_enviados (id TEXT PRIMARY KEY, em TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
      const e = await pool.query('SELECT chave, dados, removido FROM navios_estado');
      const estado = new Map(e.rows.map((l) => [l.chave, { ...(typeof l.dados === 'string' ? JSON.parse(l.dados) : l.dados), ...(l.removido ? { __removido: true } : {}) }]));
      const m = await pool.query(`SELECT * FROM navios_mudancas WHERE em >= NOW() - ($1 || ' days')::interval ORDER BY em`, [String(diasEmMemoria)]);
      return { estado, recentes: m.rows.map(deLinha) };
    },
    async persistir({ mudancas, estado, anterior, em }) {
      // Grava as mudanças e só os estados que mudaram.
      for (let i = 0; i < mudancas.length; i += 200) {
        const lote = mudancas.slice(i, i + 200);
        const params = lote.flatMap((m) => [m.em, m.chave, m.terminal, m.navio, m.viagem, m.campo, m.de, m.para]);
        const valores = lote.map((_, j) => `(${Array.from({ length: 8 }, (__, k) => `$${j * 8 + k + 1}`).join(', ')})`).join(', ');
        await pool.query(`INSERT INTO navios_mudancas (em, chave, terminal, navio, viagem, campo, de, para) VALUES ${valores}`, params);
      }
      const alterados = [...estado].filter(([chave, r]) => JSON.stringify(anterior.get(chave)) !== JSON.stringify(r));
      for (let i = 0; i < alterados.length; i += 200) {
        const lote = alterados.slice(i, i + 200);
        const params = lote.flatMap(([chave, r]) => {
          const { __removido, ...dados } = r;
          return [chave, JSON.stringify(dados), em, Boolean(__removido)];
        });
        const valores = lote.map((_, j) => `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`).join(', ');
        await pool.query(
          `INSERT INTO navios_estado (chave, dados, visto_em, removido) VALUES ${valores}
           ON CONFLICT (chave) DO UPDATE SET dados = EXCLUDED.dados, visto_em = EXCLUDED.visto_em, removido = EXCLUDED.removido`,
          params,
        );
      }
      // Limpeza diária do histórico antigo (barata: usa o índice por data).
      if (new Date(em).getUTCHours() === 3 && new Date(em).getUTCMinutes() === 0) {
        await pool.query(`DELETE FROM navios_mudancas WHERE em < NOW() - ($1 || ' days')::interval`, [String(diasHistorico)]);
        await pool.query(`DELETE FROM alertas_enviados WHERE em < NOW() - interval '60 days'`);
      }
    },
    async buscar({ desde, chave, terminal, navio, campo, limite = 500 }) {
      const where = [];
      const params = [];
      const add = (sql, v) => {
        params.push(v);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (desde) add('em >= ?', desde);
      if (chave) add('chave = ?', chave);
      if (terminal) add('terminal = ?', terminal);
      if (navio) add("upper(regexp_replace(navio, '[^A-Za-z0-9]', '', 'g')) LIKE ?", `%${normalizarChave(navio)}%`);
      if (campo) add('campo = ?', campo);
      params.push(Math.min(Number(limite) || 500, 5000));
      const { rows } = await pool.query(`SELECT * FROM navios_mudancas ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY em DESC LIMIT $${params.length}`, params);
      return rows.map(deLinha);
    },
  });
  // Alertas já enviados, para não repetir depois de reiniciar.
  const memoriaAlertas = {
    async carregar() {
      const { rows } = await pool.query(`SELECT id FROM alertas_enviados WHERE em >= NOW() - interval '60 days'`);
      return rows.map((l) => l.id);
    },
    async gravar(ids) {
      for (let i = 0; i < ids.length; i += 500) {
        const lote = ids.slice(i, i + 500);
        await pool.query(`INSERT INTO alertas_enviados (id) VALUES ${lote.map((_, j) => `($${j + 1})`).join(', ')} ON CONFLICT (id) DO NOTHING`, lote);
      }
    },
  };
  return { ...base, memoriaAlertas, encerrar: () => pool.end() };
}

/**
 * Com DATABASE_URL tenta o PostgreSQL; se o banco não responder (ou o pacote pg faltar), cai para memória.
 * Devolve o histórico já iniciado.
 */
async function iniciarHistorico(url = process.env.DATABASE_URL, opcoes = {}, log = console.log) {
  if (url) {
    try {
      const h = criarPostgres(url, opcoes);
      await h.iniciar();
      log('[historico] PostgreSQL: histórico permanente.');
      return h;
    } catch (e) {
      log(`[historico] PostgreSQL indisponível (${e.message}). Usando memória.`);
    }
  } else {
    log('[historico] sem DATABASE_URL: histórico em memória (perdido a cada reinício).');
  }
  const h = criarMemoria(opcoes);
  await h.iniciar();
  return h;
}

// Nome de cada campo do DSS como aparece na tela. Em btp e santos_brasil, data_lib_reefer é a abertura do gate reefer.
const ROTULOS = {
  registro: 'Lista do DSS',
  armador: 'Armador',
  data_prev_chegada: 'Chegada prevista',
  data_prev_atracacao: 'Atracação prevista',
  data_atracacao: 'Atracação',
  data_prev_saida: 'Saída prevista',
  data_prev_abertura_gate: 'Abertura do gate prevista',
  data_abertura_gate: 'Abertura do gate',
  data_deadline: 'Deadline',
  data_prev_lib_dry: 'Liberação dry prevista',
  data_lib_dry: 'Liberação dry',
  data_prev_lib_reefer: 'Liberação reefer prevista',
  data_lib_reefer: 'Liberação reefer',
};
const REEFER_E_GATE = new Set(['btp', 'santos_brasil']);
function rotuloCampo(campo, terminal) {
  if (REEFER_E_GATE.has(terminal) && campo === 'data_lib_reefer') return 'Abertura do gate reefer';
  if (REEFER_E_GATE.has(terminal) && campo === 'data_prev_lib_reefer') return 'Abertura do gate reefer prevista';
  return ROTULOS[campo] || campo;
}

module.exports = { iniciarHistorico, criarMemoria, compararEstados, chaveDe, rotuloCampo, CAMPOS };

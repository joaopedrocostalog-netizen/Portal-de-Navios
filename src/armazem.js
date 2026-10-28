'use strict';

// O que a equipe cadastra no portal: observações por navio e a tabela de armadores.
// Com DATABASE_URL fica no PostgreSQL; sem ela (ou se o banco não responder), em memória.

const so = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const limpo = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const iso = (v) => (v instanceof Date ? v.toISOString() : v);

class ErroDado extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.status = 400;
  }
}

function validarObservacao({ chave, texto, autor, navio, viagem, terminal }) {
  const t = String(texto ?? '').trim().slice(0, 1000);
  if (!chave || !/^[a-z_]*\|[A-Z0-9]+\|[A-Z0-9]*$/.test(chave)) throw new ErroDado('Navio inválido.');
  if (!t) throw new ErroDado('Escreva a observação.');
  return { chave, texto: t, autor: limpo(autor, 60) || 'Equipe', navio: limpo(navio, 80), viagem: limpo(viagem, 40), terminal: limpo(terminal, 40) };
}

function validarArmador({ tipo, valor, armador, autor }) {
  if (tipo !== 'viagem' && tipo !== 'navio') throw new ErroDado('Escolha se a regra vale para a viagem ou para o navio.');
  const chave = so(valor);
  if (!chave) throw new ErroDado(`Informe ${tipo === 'viagem' ? 'a viagem' : 'o nome do navio'}.`);
  const a = limpo(armador, 30).toUpperCase();
  if (!a) throw new ErroDado('Informe o armador.');
  return { tipo, chave, valor: limpo(valor, 80).toUpperCase(), armador: a, autor: limpo(autor, 60) || 'Equipe' };
}

/** Mapa para aplicar nos navios: viagem tem prioridade sobre o nome do navio. */
function criarMapa(regras) {
  const viagem = new Map();
  const navio = new Map();
  for (const r of regras) (r.tipo === 'viagem' ? viagem : navio).set(r.chave, r.armador);
  return { viagem, navio, tamanho: regras.length };
}

function criarMemoria() {
  let seq = 0;
  const observacoes = [];
  let armadores = [];
  return {
    tipo: 'memoria',
    async iniciar() {},
    observacoes: {
      async listar(chave) {
        return observacoes.filter((o) => !chave || o.chave === chave).sort((a, b) => b.em.localeCompare(a.em));
      },
      async contar() {
        const c = {};
        for (const o of observacoes) c[o.chave] = (c[o.chave] || 0) + 1;
        return c;
      },
      async adicionar(dados) {
        const o = { id: String(++seq), ...validarObservacao(dados), em: new Date().toISOString() };
        observacoes.push(o);
        return o;
      },
      async remover(id) {
        const i = observacoes.findIndex((o) => o.id === String(id));
        if (i >= 0) observacoes.splice(i, 1);
        return i >= 0;
      },
    },
    armadores: {
      async listar() {
        return [...armadores].sort((a, b) => a.valor.localeCompare(b.valor));
      },
      async salvar(dados) {
        const r = validarArmador(dados);
        armadores = armadores.filter((x) => !(x.tipo === r.tipo && x.chave === r.chave));
        const regra = { id: String(++seq), ...r, em: new Date().toISOString() };
        armadores.push(regra);
        return regra;
      },
      async remover(id) {
        const antes = armadores.length;
        armadores = armadores.filter((x) => x.id !== String(id));
        return armadores.length < antes;
      },
    },
  };
}

function criarPostgres(url) {
  const { Pool } = require('pg');
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* url inválida: o Pool reclama */
  }
  const pool = new Pool({ connectionString: url, ssl: host.endsWith('.render.com') ? { rejectUnauthorized: false } : false, max: 2, connectionTimeoutMillis: 10000 });
  pool.on('error', (e) => console.error('[armazem] conexão:', e.message));
  const obs = (l) => ({ id: String(l.id), chave: l.chave, navio: l.navio, viagem: l.viagem, terminal: l.terminal, texto: l.texto, autor: l.autor, em: iso(l.em) });
  const arm = (l) => ({ id: String(l.id), tipo: l.tipo, chave: l.chave, valor: l.valor, armador: l.armador, autor: l.autor, em: iso(l.em) });
  return {
    tipo: 'postgres',
    async iniciar() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS navios_observacoes (
          id BIGSERIAL PRIMARY KEY, chave TEXT NOT NULL, navio TEXT, viagem TEXT, terminal TEXT,
          texto TEXT NOT NULL, autor TEXT, em TIMESTAMPTZ NOT NULL DEFAULT NOW());
        CREATE INDEX IF NOT EXISTS idx_observacoes_chave ON navios_observacoes (chave, em DESC);
        CREATE TABLE IF NOT EXISTS armadores_mapa (
          id BIGSERIAL PRIMARY KEY, tipo TEXT NOT NULL, chave TEXT NOT NULL, valor TEXT NOT NULL,
          armador TEXT NOT NULL, autor TEXT, em TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (tipo, chave));`);
    },
    encerrar: () => pool.end(),
    observacoes: {
      async listar(chave) {
        const { rows } = chave
          ? await pool.query('SELECT * FROM navios_observacoes WHERE chave = $1 ORDER BY em DESC', [chave])
          : await pool.query('SELECT * FROM navios_observacoes ORDER BY em DESC LIMIT 2000');
        return rows.map(obs);
      },
      async contar() {
        const { rows } = await pool.query('SELECT chave, COUNT(*)::int AS n FROM navios_observacoes GROUP BY chave');
        return Object.fromEntries(rows.map((l) => [l.chave, Number(l.n)]));
      },
      async adicionar(dados) {
        const o = validarObservacao(dados);
        const { rows } = await pool.query('INSERT INTO navios_observacoes (chave, navio, viagem, terminal, texto, autor) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [o.chave, o.navio, o.viagem, o.terminal, o.texto, o.autor]);
        return obs(rows[0]);
      },
      async remover(id) {
        const r = await pool.query('DELETE FROM navios_observacoes WHERE id = $1', [Number(id) || 0]);
        return r.rowCount > 0;
      },
    },
    armadores: {
      async listar() {
        const { rows } = await pool.query('SELECT * FROM armadores_mapa ORDER BY valor');
        return rows.map(arm);
      },
      async salvar(dados) {
        const r = validarArmador(dados);
        const { rows } = await pool.query(
          `INSERT INTO armadores_mapa (tipo, chave, valor, armador, autor) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tipo, chave) DO UPDATE SET armador = EXCLUDED.armador, valor = EXCLUDED.valor, autor = EXCLUDED.autor, em = NOW() RETURNING *`,
          [r.tipo, r.chave, r.valor, r.armador, r.autor],
        );
        return arm(rows[0]);
      },
      async remover(id) {
        const r = await pool.query('DELETE FROM armadores_mapa WHERE id = $1', [Number(id) || 0]);
        return r.rowCount > 0;
      },
    },
  };
}

/** Com DATABASE_URL usa o PostgreSQL; se não der, memória. */
async function iniciarArmazem(url = process.env.DATABASE_URL, log = console.log) {
  if (url) {
    try {
      const a = criarPostgres(url);
      await a.iniciar();
      return a;
    } catch (e) {
      log(`[armazem] PostgreSQL indisponível (${e.message}). Observações e armadores ficam em memória.`);
    }
  }
  const a = criarMemoria();
  await a.iniciar();
  return a;
}

module.exports = { iniciarArmazem, criarMemoria, criarMapa, ErroDado, so };

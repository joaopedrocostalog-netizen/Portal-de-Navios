'use strict';

// Armazenamento dos contêineres monitorados.
// Com DATABASE_URL usa PostgreSQL; sem ela, guarda em memória (some quando o servidor reinicia).

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

// campo usado na API -> coluna no banco
const CAMPOS = {
  armador: 'armador',
  descricao: 'descricao',
  perigoso: 'perigoso',
  classeRisco: 'classe_risco',
  navioNome: 'navio_nome',
  navioViagem: 'navio_viagem',
  situacao: 'situacao',
};

const PADROES = {
  armador: 'AUTO',
  descricao: null,
  perigoso: false,
  classeRisco: null,
  navioNome: null,
  navioViagem: null,
  situacao: 'monitorando',
};

function iso(valor) {
  if (!valor) return null;
  return valor instanceof Date ? valor.toISOString() : valor;
}

// ---------------------------------------------------------------------------
// Memória
// ---------------------------------------------------------------------------
function criarMemoria() {
  const conteineres = new Map();

  return {
    tipo: 'memoria',
    async iniciar() {},
    async encerrar() {},
    async listarConteineres({ situacao } = {}) {
      return [...conteineres.values()]
        .filter((c) => !situacao || c.situacao === situacao)
        .sort((a, b) => a.numero.localeCompare(b.numero))
        .map((c) => ({ ...c }));
    },
    async obterConteiner(numero) {
      const c = conteineres.get(numero);
      return c ? { ...c } : null;
    },
    async salvarConteiner(numero, campos) {
      const agora = new Date().toISOString();
      const atual = conteineres.get(numero) || { numero, ...PADROES, criadoEm: agora };
      const novo = { ...atual };
      for (const [k, v] of Object.entries(campos)) if (k in CAMPOS && v !== undefined) novo[k] = v;
      novo.atualizadoEm = agora;
      conteineres.set(numero, novo);
      return { ...novo };
    },
    async removerConteiner(numero) {
      return conteineres.delete(numero);
    },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------
function criarPostgres(url) {
  const { Pool } = require('pg');
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  // A URL interna do Render (host "dpg-...") não usa SSL; a externa (*.render.com) exige.
  const ssl = config.databaseSsl || host.endsWith('.render.com') ? { rejectUnauthorized: false } : false;
  const pool = new Pool({ connectionString: url, ssl, max: 5 });

  function deLinha(l) {
    const obj = { numero: l.numero };
    for (const [campo, coluna] of Object.entries(CAMPOS)) obj[campo] = l[coluna] ?? null;
    obj.criadoEm = iso(l.criado_em);
    obj.atualizadoEm = iso(l.atualizado_em);
    return obj;
  }

  return {
    tipo: 'postgres',
    async iniciar() {
      const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      await pool.query(sql);
    },
    async encerrar() {
      await pool.end();
    },
    async listarConteineres({ situacao } = {}) {
      const { rows } = situacao
        ? await pool.query('SELECT * FROM conteineres WHERE situacao = $1 ORDER BY numero', [situacao])
        : await pool.query('SELECT * FROM conteineres ORDER BY numero');
      return rows.map(deLinha);
    },
    async obterConteiner(numero) {
      const { rows } = await pool.query('SELECT * FROM conteineres WHERE numero = $1', [numero]);
      return rows[0] ? deLinha(rows[0]) : null;
    },
    async salvarConteiner(numero, campos) {
      const entradas = Object.entries(campos).filter(([k, v]) => k in CAMPOS && v !== undefined);
      const colunas = entradas.map(([k]) => CAMPOS[k]);
      const valores = entradas.map(([, v]) => v);
      const marcadores = valores.map((_, i) => `$${i + 2}`);
      const atualizacoes = colunas.map((c) => `${c} = EXCLUDED.${c}`).concat('atualizado_em = NOW()');
      const sql =
        `INSERT INTO conteineres (numero${colunas.map((c) => `, ${c}`).join('')}) ` +
        `VALUES ($1${marcadores.map((m) => `, ${m}`).join('')}) ` +
        `ON CONFLICT (numero) DO UPDATE SET ${atualizacoes.join(', ')} RETURNING *`;
      const { rows } = await pool.query(sql, [numero, ...valores]);
      return deLinha(rows[0]);
    },
    async removerConteiner(numero) {
      const { rowCount } = await pool.query('DELETE FROM conteineres WHERE numero = $1', [numero]);
      return rowCount > 0;
    },
  };
}

function criarArmazenamento(url = config.databaseUrl) {
  return url ? criarPostgres(url) : criarMemoria();
}

module.exports = { criarArmazenamento };

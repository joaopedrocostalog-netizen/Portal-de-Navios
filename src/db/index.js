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
  navioMmsi: 'navio_mmsi',
  navioImo: 'navio_imo',
  navioNome: 'navio_nome',
  portoDestino: 'porto_destino',
  locodeDestino: 'locode_destino',
  etaEtracking: 'eta_etracking',
  progresso: 'progresso',
  localAtual: 'local_atual',
  situacao: 'situacao',
  ultimoRastreioEm: 'ultimo_rastreio_em',
  rastreioBruto: 'rastreio_bruto',
};

const PADROES = {
  armador: 'AUTO',
  descricao: null,
  perigoso: false,
  classeRisco: null,
  navioMmsi: null,
  navioImo: null,
  navioNome: null,
  portoDestino: null,
  locodeDestino: null,
  etaEtracking: null,
  progresso: null,
  localAtual: null,
  situacao: 'monitorando',
  ultimoRastreioEm: null,
  rastreioBruto: null,
};

function iso(valor) {
  if (!valor) return null;
  return valor instanceof Date ? valor.toISOString() : valor;
}

function dataValida(valor) {
  return valor && !Number.isNaN(Date.parse(valor)) ? valor : null;
}

// Eventos realizados são históricos: a data faz parte da chave.
// Eventos previstos têm uma chave só por evento+local, para a data prevista ser atualizada no lugar
// (senão cada mudança de previsão do armador criaria uma linha nova).
function chavePrevista(e) {
  return `previsto|${e.evento || ''}|${e.locode || ''}`;
}

function chaveEvento(e) {
  return e.realizado ? `${e.evento || ''}|${e.locode || ''}|${e.dataHora || ''}` : chavePrevista(e);
}

// ---------------------------------------------------------------------------
// Memória
// ---------------------------------------------------------------------------
function criarMemoria() {
  const conteineres = new Map();
  const eventos = new Map();

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
      eventos.delete(numero);
      return conteineres.delete(numero);
    },
    async registrarEventos(numero, lista, fonte) {
      const atuais = eventos.get(numero) || new Map();
      for (const e of lista) {
        const chave = chaveEvento(e);
        if (e.realizado) atuais.delete(chavePrevista(e)); // a previsão virou fato
        const anterior = atuais.get(chave);
        if (anterior && e.realizado) continue;
        atuais.set(chave, { ...e, realizado: Boolean(e.realizado), fonte, registradoEm: anterior?.registradoEm || new Date().toISOString() });
      }
      eventos.set(numero, atuais);
    },
    async listarEventos(numero) {
      return [...(eventos.get(numero) || new Map()).values()].sort((a, b) =>
        String(a.dataHora || '').localeCompare(String(b.dataHora || '')),
      );
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
    for (const [campo, coluna] of Object.entries(CAMPOS)) obj[campo] = l[coluna];
    obj.etaEtracking = iso(obj.etaEtracking);
    obj.ultimoRastreioEm = iso(obj.ultimoRastreioEm);
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
      const valores = entradas.map(([k, v]) => (k === 'rastreioBruto' && v !== null ? JSON.stringify(v) : v));
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
    async registrarEventos(numero, lista, fonte) {
      for (const e of lista) {
        if (e.realizado) {
          await pool.query('DELETE FROM eventos_conteiner WHERE numero = $1 AND chave = $2', [numero, chavePrevista(e)]);
        }
        await pool.query(
          `INSERT INTO eventos_conteiner (numero, chave, evento, porto, locode, data_hora, realizado, navio, fonte)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (numero, chave) DO UPDATE SET
             data_hora = EXCLUDED.data_hora, porto = EXCLUDED.porto, navio = EXCLUDED.navio, fonte = EXCLUDED.fonte
           WHERE NOT eventos_conteiner.realizado`,
          [numero, chaveEvento(e), e.evento, e.porto, e.locode, dataValida(e.dataHora), Boolean(e.realizado), e.navio, fonte],
        );
      }
    },
    async listarEventos(numero) {
      const { rows } = await pool.query(
        'SELECT * FROM eventos_conteiner WHERE numero = $1 ORDER BY data_hora NULLS LAST, id',
        [numero],
      );
      return rows.map((l) => ({
        evento: l.evento,
        porto: l.porto,
        locode: l.locode,
        dataHora: iso(l.data_hora),
        realizado: l.realizado,
        navio: l.navio,
        fonte: l.fonte,
        registradoEm: iso(l.registrado_em),
      }));
    },
  };
}

function criarArmazenamento(url = config.databaseUrl) {
  return url ? criarPostgres(url) : criarMemoria();
}

module.exports = { criarArmazenamento };

'use strict';

// Portal de Navios: API e página em cima da API Portal de Navios do DSS. Sem dependências externas.
//
//   GET /api/health                       status e configuração
//   GET /api/navios?terminal=&armador=&navio=&viagem=&situacao=&gate=&de=&ate=&ordenar=
//   GET /api/resumo?horas=48 (+ os mesmos filtros)
//   GET /api/dss/bruto                    resposta original do DSS, sem tratamento

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { criarCliente, filtrar, resumir, ErroDss } = require('./dss');

const env = process.env;
const config = {
  porta: Number(env.PORT) || 3000,
  dssUrl: [env.DSS_URL, env.NAVIOS_OF_DSS].map((v) => String(v || '').trim()).find((v) => /^https?:\/\//i.test(v)) || '',
  cacheSegundos: Number(env.CACHE_SEGUNDOS) || 60,
};

const PAGINA = path.join(__dirname, '..', 'public', 'index.html');
const ORDENS = {
  referencia: (r) => r.referencia,
  chegada: (r) => r.datas.prevChegada,
  atracacao: (r) => r.datas.atracacao || r.datas.prevAtracacao,
  deadline: (r) => r.datas.deadline,
  navio: (r) => r.navio,
};

function criarServidor(cliente = config.dssUrl ? criarCliente({ url: config.dssUrl, usuario: env.DSS_USUARIO, senha: env.DSS_SENHA, token: env.DSS_TOKEN, cacheSegundos: config.cacheSegundos }) : null) {
  async function dados(q) {
    if (!cliente) throw new ErroDss('DSS não configurado: defina DSS_URL com o endereço do endpoint listarNavios.', 503);
    return cliente.listar({ forcar: q.atualizar === 'true' });
  }

  const rotas = {
    '/api/health': async () => ({ ok: true, dss: cliente ? 'configurado' : 'não configurado', cacheSegundos: config.cacheSegundos }),

    '/api/navios': async (q) => {
      const r = await dados(q);
      const ordem = ORDENS[q.ordenar] || ORDENS.referencia;
      const navios = filtrar(r.registros, q).sort((a, b) => String(ordem(a) ?? '~').localeCompare(String(ordem(b) ?? '~')));
      return {
        consultadoEm: r.consultadoEm,
        aviso: r.aviso,
        apiVersion: r.apiVersion,
        timezone: r.timezone,
        qtdRegistrosDss: r.qtdRegistros,
        total: navios.length,
        terminais: [...new Set(r.registros.map((x) => x.terminal).filter(Boolean))].sort(),
        armadores: [...new Set(r.registros.map((x) => x.armador).filter(Boolean))].sort(),
        navios,
      };
    },

    '/api/resumo': async (q) => {
      const r = await dados(q);
      const horas = Math.min(Math.max(Number(q.horas) || 48, 1), 24 * 30);
      return { consultadoEm: r.consultadoEm, aviso: r.aviso, ...resumir(filtrar(r.registros, q), { horas }) };
    },

    '/api/dss/bruto': async (q) => (await dados({ ...q, atualizar: 'true' })).bruto,
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const enviar = (status, corpo, tipo = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': tipo, 'access-control-allow-origin': env.CORS_ORIGIN || '*' });
      res.end(typeof corpo === 'string' || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo));
    };
    try {
      if (req.method !== 'GET') return enviar(405, { erro: 'Use GET.' });
      if (url.pathname === '/' || url.pathname === '/index.html') return enviar(200, fs.readFileSync(PAGINA), 'text/html; charset=utf-8');
      const rota = rotas[url.pathname.replace(/\/$/, '')];
      if (!rota) return enviar(404, { erro: `Rota ${url.pathname} não existe.` });
      return enviar(200, await rota(Object.fromEntries(url.searchParams)));
    } catch (e) {
      if (e instanceof ErroDss) return enviar(e.status, { erro: e.message, ...(e.detalhes ? { detalhes: e.detalhes } : {}) });
      console.error(e);
      return enviar(500, { erro: 'Erro interno.' });
    }
  });
}

if (require.main === module) {
  const servidor = criarServidor();
  servidor.listen(config.porta, async () => {
    console.log(`Portal de Navios na porta ${config.porta}.`);
    if (!config.dssUrl) return console.log('[diagnóstico] DSS_URL não configurado.');
    const u = new URL(config.dssUrl);
    console.log(`[diagnóstico] DSS: ${u.host}${u.pathname} | login: ${env.DSS_TOKEN ? 'token' : env.DSS_USUARIO || u.username ? 'Basic' : 'nenhum'}`);
    try {
      const r = await criarCliente({ url: config.dssUrl, usuario: env.DSS_USUARIO, senha: env.DSS_SENHA, token: env.DSS_TOKEN }).listar();
      const terminais = [...new Set(r.registros.map((x) => x.terminal))].join(', ');
      console.log(`[diagnóstico] DSS OK: ${r.qtdRegistros} atracações (apiVersion ${r.apiVersion}). Terminais: ${terminais || '-'}.`);
    } catch (e) {
      console.log(`[diagnóstico] ${e.message}`);
    }
  });
  process.on('SIGTERM', () => servidor.close(() => process.exit(0)));
}

module.exports = { criarServidor };

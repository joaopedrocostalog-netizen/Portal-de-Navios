'use strict';

// Portal de Navios: API e página em cima da API Portal de Navios do DSS. Sem dependências externas.
//
//   GET /api/painel?dias=7 (+ filtros)    tudo que a página precisa, numa chamada só (lista + resumo)
//   GET /api/navios?terminal=&armador=&navio=&viagem=&situacao=&gate=&de=&ate=&dias=&encerrados=&ordenar=
//   GET /api/resumo?horas=48 (+ os mesmos filtros)
//   GET /api/mudancas?horas=24&navio=&terminal=&campo=   histórico de mudanças das datas
//   GET /api/navio?chave=terminal|NAVIO|VIAGEM           detalhe do navio: datas atuais + todas as mudanças
//   GET /api/dss/bruto                    resposta original do DSS, sem tratamento
//   GET /api/health                       status, idade do cache e último erro
//
// Desempenho: o DSS é consultado em segundo plano (as páginas nunca esperam por ele), as respostas vão
// comprimidas com gzip e com ETag (o navegador recebe 304 quando nada mudou), e no Render o servidor
// faz um ping no próprio endereço público para não hibernar.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { criarCliente, filtrar, resumir, ErroDss } = require('./dss');
const { iniciarHistorico, criarMemoria, chaveDe, rotuloCampo } = require('./historico');

const env = process.env;
const config = {
  porta: Number(env.PORT) || 3000,
  dssUrl: [env.DSS_URL, env.NAVIOS_OF_DSS].map((v) => String(v || '').trim()).find((v) => /^https?:\/\//i.test(v)) || '',
  cacheSegundos: Number(env.CACHE_SEGUNDOS) || 60,
  // Render define RENDER_EXTERNAL_URL; o ping a cada 10 min evita a hibernação do plano gratuito (15 min sem acesso).
  urlPublica: env.URL_PUBLICA || env.RENDER_EXTERNAL_URL || '',
  manterAcordado: env.MANTER_ACORDADO !== 'false',
  pingMinutos: Number(env.PING_MINUTOS) || 10,
};

const PAGINA = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'));
const ORDENS = {
  referencia: (r) => r.referencia,
  chegada: (r) => r.datas.prevChegada,
  atracacao: (r) => r.datas.atracacao || r.datas.prevAtracacao,
  deadline: (r) => r.datas.deadline,
  navio: (r) => r.navio,
};

function criarClientePadrao(aoAtualizar = null) {
  if (!config.dssUrl) return null;
  return criarCliente({ url: config.dssUrl, usuario: env.DSS_USUARIO, senha: env.DSS_SENHA, token: env.DSS_TOKEN, cacheSegundos: config.cacheSegundos, aoAtualizar });
}

const HORA = 36e5;
const comRotulo = (m) => ({ ...m, rotulo: rotuloCampo(m.campo, m.terminal) });

function criarServidor(cliente = criarClientePadrao(), historico = criarMemoria()) {
  async function dados(q) {
    if (!cliente) throw new ErroDss('DSS não configurado: defina DSS_URL com o endereço do endpoint listarNavios.', 503);
    return cliente.listar({ forcar: q.atualizar === 'true' });
  }

  /** Cada navio ganha a chave do histórico e quantas datas mudaram nas últimas 24 h. */
  function marcarMudancas(navios) {
    const contagem = historico.contarPorChave(new Date(Date.now() - 24 * HORA).toISOString());
    return navios.map((n) => {
      const chave = chaveDe(n);
      return contagem[chave] ? { ...n, chave, mudancas24h: contagem[chave] } : { ...n, chave };
    });
  }

  function lista(r, q) {
    const ordem = ORDENS[q.ordenar] || ORDENS.referencia;
    const navios = marcarMudancas(filtrar(r.registros, q).sort((a, b) => String(ordem(a) ?? '~').localeCompare(String(ordem(b) ?? '~'))));
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
  }

  const horasResumo = (q) => Math.min(Math.max(Number(q.horas) || 48, 1), 24 * 30);

  const rotas = {
    '/api/health': async () => {
      const r = cliente ? await cliente.listar().catch((e) => ({ erro: e.message })) : null;
      return {
        ok: true,
        dss: cliente ? 'configurado' : 'não configurado',
        cacheSegundos: config.cacheSegundos,
        historico: historico.tipo,
        ...(r?.consultadoEm ? { consultadoEm: r.consultadoEm, idadeSegundos: Math.round((Date.now() - Date.parse(r.consultadoEm)) / 1000), registros: r.qtdRegistros } : {}),
        ...(r?.aviso || r?.erro ? { erro: r.aviso || r.erro } : {}),
      };
    },
    '/api/painel': async (q) => {
      const r = await dados(q);
      const l = lista(r, q);
      // Mudanças das últimas 24 h, só dos navios que estão na visão filtrada.
      const chaves = new Set(l.navios.map((n) => n.chave));
      const mudancas = (await historico.listar({ desde: new Date(Date.now() - 24 * HORA).toISOString(), limite: 5000 }))
        .filter((m) => chaves.has(m.chave))
        .slice(0, 100)
        .map(comRotulo);
      return { ...l, historico: historico.tipo, mudancas, resumo: resumir(filtrar(r.registros, q), { horas: horasResumo(q) }) };
    },
    // Histórico: ?horas=24 (ou desde=ISO) &terminal= &navio= &campo= &chave= &limite=
    '/api/mudancas': async (q) => {
      const horas = Math.min(Math.max(Number(q.horas) || 24, 1), 24 * 365);
      const desde = q.desde || new Date(Date.now() - horas * HORA).toISOString();
      const mudancas = await historico.listar({ desde, chave: q.chave, terminal: q.terminal, navio: q.navio, campo: q.campo, limite: Math.min(Number(q.limite) || 500, 5000) });
      return { historico: historico.tipo, desde, total: mudancas.length, mudancas: mudancas.map(comRotulo) };
    },
    // Detalhe de um navio: ?chave=terminal|NAVIO|VIAGEM (ou terminal=&navio=&viagem=)
    '/api/navio': async (q) => {
      const chave = q.chave || chaveDe({ terminal: q.terminal, navio: q.navio, viagem: q.viagem });
      const r = await dados({});
      const navio = r.registros.find((n) => chaveDe(n) === chave);
      const mudancas = (await historico.listar({ chave, limite: 1000 })).map(comRotulo);
      if (!navio && !mudancas.length) throw new ErroDss(`Navio ${chave} não está na lista do DSS nem no histórico.`, 404);
      return { chave, consultadoEm: r.consultadoEm, historico: historico.tipo, navio: navio ? { ...navio, chave } : null, mudancas };
    },
    '/api/navios': async (q) => lista(await dados(q), q),
    '/api/resumo': async (q) => {
      const r = await dados(q);
      return { consultadoEm: r.consultadoEm, aviso: r.aviso, ...resumir(filtrar(r.registros, q), { horas: horasResumo(q) }) };
    },
    '/api/dss/bruto': async (q) => (await dados({ ...q, atualizar: 'true' })).bruto,
  };

  /** Envia com ETag (304 quando o navegador já tem a mesma versão) e gzip quando o navegador aceita. */
  function enviar(req, res, status, corpo, tipo = 'application/json; charset=utf-8') {
    let buffer = Buffer.isBuffer(corpo) ? corpo : Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    const etag = `W/"${crypto.createHash('sha1').update(buffer).digest('base64url').slice(0, 22)}"`;
    const cabecalhos = {
      'content-type': tipo,
      'cache-control': 'no-cache',
      etag,
      vary: 'accept-encoding',
      'access-control-allow-origin': env.CORS_ORIGIN || '*',
    };
    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.writeHead(304, cabecalhos);
      return res.end();
    }
    if (buffer.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      buffer = zlib.gzipSync(buffer, { level: 6 });
      cabecalhos['content-encoding'] = 'gzip';
    }
    cabecalhos['content-length'] = buffer.length;
    res.writeHead(status, cabecalhos);
    return res.end(buffer);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return enviar(req, res, 405, { erro: 'Use GET.' });
      if (url.pathname === '/' || url.pathname === '/index.html') return enviar(req, res, 200, PAGINA, 'text/html; charset=utf-8');
      const rota = rotas[url.pathname.replace(/\/$/, '')];
      if (!rota) return enviar(req, res, 404, { erro: `Rota ${url.pathname} não existe.` });
      return enviar(req, res, 200, await rota(Object.fromEntries(url.searchParams)));
    } catch (e) {
      if (e instanceof ErroDss) return enviar(req, res, e.status, { erro: e.message, ...(e.detalhes ? { detalhes: e.detalhes } : {}) });
      console.error(e);
      return enviar(req, res, 500, { erro: 'Erro interno.' });
    }
  });
}

async function main() {
  const historico = await iniciarHistorico();
  const cliente = criarClientePadrao((registros, em) => historico.registrar(registros, em).then((novas) => novas.length && console.log(`[historico] ${novas.length} mudança(s) detectada(s).`)));
  const servidor = criarServidor(cliente, historico);
  servidor.listen(config.porta, () => {
    console.log(`Portal de Navios na porta ${config.porta}.`);
    if (!cliente) return console.log('[diagnóstico] DSS_URL não configurado.');
    const u = new URL(config.dssUrl);
    console.log(`[diagnóstico] DSS: ${u.host}${u.pathname} | login: ${env.DSS_TOKEN ? 'token' : env.DSS_USUARIO || u.username ? 'Basic' : 'nenhum'} | atualização a cada ${config.cacheSegundos} s`);

    // Atualização em segundo plano: a primeira consulta já serve de diagnóstico.
    let primeira = true;
    cliente.iniciarAtualizacao(config.cacheSegundos * 1000, (e) => console.log(`[dss] ${e.message}`));
    cliente
      .listar()
      .then((r) => {
        const terminais = [...new Set(r.registros.map((x) => x.terminal))].join(', ');
        console.log(`[diagnóstico] DSS OK: ${r.qtdRegistros} atracações (apiVersion ${r.apiVersion}). Terminais: ${terminais || '-'}.`);
      })
      .catch((e) => primeira && console.log(`[diagnóstico] ${e.message}`))
      .finally(() => {
        primeira = false;
      });

    // Contra a hibernação do plano gratuito do Render.
    if (config.manterAcordado && config.urlPublica) {
      const alvo = `${config.urlPublica.replace(/\/$/, '')}/api/health`;
      setInterval(() => fetch(alvo).catch((e) => console.log(`[ping] falhou: ${e.message}`)), config.pingMinutos * 60e3).unref();
      console.log(`[ping] mantendo o serviço acordado: ${alvo} a cada ${config.pingMinutos} min.`);
    }
  });
  process.on('SIGTERM', () => servidor.close(() => process.exit(0)));
}

if (require.main === module) main();

module.exports = { criarServidor };

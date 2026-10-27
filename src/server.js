'use strict';

// Portal de Navios: API e página em cima da API Portal de Navios do DSS. Sem dependências externas.
//
//   GET /api/painel?dias=7 (+ filtros)    tudo que a página precisa, numa chamada só (lista + resumo)
//   GET /api/navios?terminal=&armador=&navio=&viagem=&situacao=&gate=&de=&ate=&dias=&encerrados=&ordenar=
//   GET /api/resumo?horas=48 (+ os mesmos filtros)
//   GET /api/mudancas?horas=24&navio=&terminal=&campo=   histórico de mudanças das datas
//   GET /api/navio?chave=terminal|NAVIO|VIAGEM           detalhe do navio: datas atuais + todas as mudanças
//   GET /api/navios.xlsx (+ filtros)                      Excel da visão filtrada e das mudanças de 7 dias
//   GET /api/qualidade                                    qualidade dos dados por terminal
//   GET /api/alertas                                      situação dos alertas por e-mail
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
const { criarAlertas, criarEnvio } = require('./alertas');
const { criarXlsx } = require('./xlsx');
const { avaliarQualidade, textoQualidade, PROBLEMAS } = require('./qualidade');

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

// ------------------------------------------------------------------ exportação para Excel
const SITUACAO = {
  previsto: 'Previsto', aguardando_atracacao: 'Aguardando atracação', chegada_passou: 'Chegada passou', atracado: 'Atracado', encerrado: 'Encerrado',
  aguardando: 'Aguardando', aberto: 'Aberto', sem_dado: 'Sem dado', liberado: 'Liberado', atrasado: 'Atrasado',
};
const TERMINAL = { btp: 'BTP', santos_brasil: 'Santos Brasil', embraport: 'Embraport (DPW)' };
const sit = (v) => SITUACAO[v] || v || '';
const dssIso = (v) => (v ? `${String(v).replace(' ', 'T')}Z` : null);

function planilhaNavios(navios) {
  const colunas = [
    ['Navio', 'texto', 24], ['Viagem', 'texto', 12], ['Armador', 'texto', 10], ['Armador deduzido', 'texto', 12], ['Terminal', 'texto', 16], ['Situação', 'texto', 20],
    ['Chegada prevista', 'data'], ['Atracação prevista', 'data'], ['Atracação', 'data'], ['Espera atracação (h)', 'numero', 12], ['Saída prevista', 'data'],
    ['Gate dry', 'texto', 12], ['Abertura gate prevista', 'data'], ['Abertura gate', 'data'],
    ['Gate reefer', 'texto', 12], ['Abertura gate reefer prevista', 'data'], ['Abertura gate reefer', 'data'],
    ['Deadline', 'data'], ['Horas até deadline', 'numero', 12],
    ['Liberação dry', 'texto', 12], ['Liberação dry prevista', 'data'], ['Liberação dry real', 'data'],
    ['Liberação reefer', 'texto', 12], ['Liberação reefer prevista', 'data'], ['Liberação reefer real', 'data'],
    ['Datas que mudaram (24 h)', 'numero', 12], ['Dados ajustados', 'texto', 40],
  ];
  return {
    nome: 'Navios',
    colunas: colunas.map(([titulo, tipo, largura]) => ({ titulo, tipo, largura })),
    linhas: navios.map((n) => [
      n.navio, n.viagem, n.armador, n.armadorOrigem && n.armadorOrigem !== 'dss' ? n.armadorOrigem : '', TERMINAL[n.terminal] || n.terminal, sit(n.situacao.navio),
      n.datas.prevChegada, n.datas.prevAtracacao, n.datas.atracacao, n.horas.esperaAtracacao === null ? null : Math.round(n.horas.esperaAtracacao), n.datas.prevSaida,
      sit(n.situacao.gate), n.datas.prevAberturaGate, n.datas.aberturaGate,
      sit(n.situacao.gateReefer), n.datas.prevAberturaGateReefer, n.datas.aberturaGateReefer,
      n.datas.deadline, n.horas.ateDeadline,
      sit(n.situacao.dry), n.datas.prevLiberacaoDry, n.datas.liberacaoDry,
      sit(n.situacao.reefer), n.datas.prevLiberacaoReefer, n.datas.liberacaoReefer,
      n.mudancas24h || 0, n.qualidade.filter((q) => PROBLEMAS[q.problema]).map((q) => `${q.campo}: ${PROBLEMAS[q.problema]}`).join('; '),
    ]),
  };
}

function planilhaMudancas(mudancas) {
  return {
    nome: 'Mudanças (7 dias)',
    colunas: [
      { titulo: 'Quando', tipo: 'data' }, { titulo: 'Navio', largura: 24 }, { titulo: 'Viagem', largura: 12 }, { titulo: 'Terminal', largura: 16 },
      { titulo: 'Campo', largura: 26 }, { titulo: 'De', tipo: 'data' }, { titulo: 'Para', tipo: 'data' }, { titulo: 'Diferença (h)', tipo: 'numero', largura: 12 }, { titulo: 'Observação', largura: 22 },
    ],
    linhas: mudancas
      .filter((m) => m.campo !== 'armador')
      .map((m) => {
        const registro = m.campo === 'registro';
        const de = registro ? null : dssIso(m.de);
        const para = registro ? null : dssIso(m.para);
        const dif = de && para ? Math.round((Date.parse(para) - Date.parse(de)) / HORA) : null;
        const obs = registro ? { novo: 'entrou na lista do DSS', removido: 'saiu da lista do DSS', voltou: 'voltou à lista do DSS' }[m.para] : !de ? 'data informada' : !para ? 'data apagada' : '';
        return [m.em, m.navio, m.viagem, TERMINAL[m.terminal] || m.terminal, rotuloCampo(m.campo, m.terminal), de, para, dif, obs];
      }),
  };
}

function criarServidor(cliente = criarClientePadrao(), historico = criarMemoria(), alertas = null) {
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
      const a = alertas?.estado();
      const resumoAlertas = a?.ativo ? { para: a.para, ultimoEnvio: a.ultimoEnvio?.em || null, erro: a.ultimoErro?.mensagem || null } : null;
      return { ...l, historico: historico.tipo, alertas: resumoAlertas, mudancas, resumo: resumir(filtrar(r.registros, q), { horas: horasResumo(q) }) };
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
    // Excel da visão filtrada (mesmos filtros de /api/navios) + mudanças dos últimos 7 dias desses navios.
    '/api/navios.xlsx': async (q) => {
      const l = lista(await dados(q), q);
      const chaves = new Set(l.navios.map((n) => n.chave));
      const mudancas = (await historico.listar({ desde: new Date(Date.now() - 7 * 24 * HORA).toISOString(), limite: 20000 })).filter((m) => chaves.has(m.chave));
      const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      return { arquivo: criarXlsx([planilhaNavios(l.navios), planilhaMudancas(mudancas)]), nome: `portal-de-navios-${hoje}.xlsx`, tipo: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    },
    // Qualidade dos dados por terminal (sobre tudo o que o DSS enviou, sem filtros).
    '/api/qualidade': async () => {
      const r = await dados({});
      const mudancas = await historico.listar({ desde: new Date(Date.now() - 7 * 24 * HORA).toISOString(), limite: 50000 });
      const terminais = avaliarQualidade(r.bruto.registros, r.registros, mudancas);
      return { consultadoEm: r.consultadoEm, historico: historico.tipo, terminais, texto: textoQualidade(terminais) };
    },
    // Situação dos alertas por e-mail: regras, fila, último envio e último erro.
    '/api/alertas': async () => (alertas ? alertas.estado() : { ativo: false }),
    // Envia um e-mail de teste para ALERTA_PARA (no máximo um a cada 10 min).
    '/api/alertas/teste': async () => {
      if (!alertas) throw new ErroDss('Alertas não configurados.', 503);
      try {
        return await alertas.testar();
      } catch (e) {
        throw new ErroDss(e.message, 400);
      }
    },
    '/api/dss/bruto': async (q) => (await dados({ ...q, atualizar: 'true' })).bruto,
  };

  /** Envia com ETag (304 quando o navegador já tem a mesma versão) e gzip quando o navegador aceita. */
  function enviar(req, res, status, corpo, tipo = 'application/json; charset=utf-8', extras = {}) {
    let buffer = Buffer.isBuffer(corpo) ? corpo : Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    const etag = `W/"${crypto.createHash('sha1').update(buffer).digest('base64url').slice(0, 22)}"`;
    const cabecalhos = {
      ...extras,
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
    if (buffer.length > 1024 && !/zip|sheet/.test(tipo) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
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
      const resultado = await rota(Object.fromEntries(url.searchParams));
      if (resultado?.arquivo) return enviar(req, res, 200, resultado.arquivo, resultado.tipo, { 'content-disposition': `attachment; filename="${resultado.nome}"` });
      return enviar(req, res, 200, resultado);
    } catch (e) {
      if (e instanceof ErroDss) return enviar(req, res, e.status, { erro: e.message, ...(e.detalhes ? { detalhes: e.detalhes } : {}) });
      console.error(e);
      return enviar(req, res, 500, { erro: 'Erro interno.' });
    }
  });
}

async function main() {
  const historico = await iniciarHistorico();

  let alertas = null;
  try {
    const envio = criarEnvio({ resendKey: env.RESEND_API_KEY, brevoKey: env.BREVO_API_KEY, de: env.ALERTA_DE, para: env.ALERTA_PARA });
    alertas = criarAlertas({
      envio,
      memoria: historico.memoriaAlertas,
      persistente: historico.tipo === 'postgres',
      filtro: Object.fromEntries(new URLSearchParams(env.ALERTA_FILTRO || '')),
      deadlineHoras: Number(env.ALERTA_DEADLINE_HORAS) || 24,
      mudancaMinHoras: env.ALERTA_MUDANCA_MIN_HORAS !== undefined && env.ALERTA_MUDANCA_MIN_HORAS !== '' ? Number(env.ALERTA_MUDANCA_MIN_HORAS) : 1,
      url: config.urlPublica,
    });
    console.log(envio ? `[alertas] e-mail via ${envio.provedor} para ${envio.para.join(', ')} a cada ${Number(env.ALERTA_MINUTOS) || 15} min.` : '[alertas] desligados: defina RESEND_API_KEY (ou BREVO_API_KEY) e ALERTA_PARA.');
    if (envio) setInterval(() => alertas.despachar(), (Number(env.ALERTA_MINUTOS) || 15) * 60e3).unref();
  } catch (e) {
    console.log(`[alertas] configuração inválida: ${e.message}`);
  }

  const cliente = criarClientePadrao(async (registros, em, normalizados) => {
    const novas = await historico.registrar(registros, em);
    if (novas.length) console.log(`[historico] ${novas.length} mudança(s) detectada(s).`);
    if (alertas) {
      const eventos = await alertas.avaliar(normalizados, novas);
      // A primeira consulta sai na hora (serve de confirmação de que os alertas funcionam); depois, no intervalo.
      if (eventos.length && !alertas.estado().ultimoEnvio && !alertas.estado().ultimoErro) await alertas.despachar();
    }
  });
  const servidor = criarServidor(cliente, historico, alertas);
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

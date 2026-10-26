'use strict';

// API HTTP do Portal de Navios, usando apenas o módulo http nativo do Node
// (sem framework, para manter poucas dependências).

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const pacote = require('../package.json');
const shipxy = require('./services/shipxy');
const etracking = require('./services/etracking');
const { sincronizar, semBruto } = require('./services/conteineres');
const { preverEntrada } = require('./services/previsao');
const {
  ErroApi,
  digitoVerificadorValido,
  normalizarNumeroConteiner,
  normalizarArmador,
  normalizarPorto,
  normalizarDias,
  querBruto,
} = require('./util');

const PASTA_PUBLICA = path.join(__dirname, '..', 'public');
const LIMITE_CORPO = 100 * 1024;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on('data', (parte) => {
      tamanho += parte.length;
      if (tamanho > LIMITE_CORPO) {
        reject(new ErroApi('Corpo da requisição muito grande.', { status: 413 }));
        req.destroy();
        return;
      }
      partes.push(parte);
    });
    req.on('end', () => {
      const texto = Buffer.concat(partes).toString('utf8');
      if (!texto.trim()) return resolve({});
      try {
        resolve(JSON.parse(texto));
      } catch {
        reject(new ErroApi('JSON inválido no corpo da requisição.', { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function cabecalhosCors(req) {
  const permitido = config.corsOrigin.split(',').map((s) => s.trim());
  const origem = req.headers.origin;
  const valor = permitido.includes('*') ? '*' : permitido.includes(origem) ? origem : null;
  if (!valor) return {};
  return {
    'access-control-allow-origin': valor,
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-expose-headers': 'retry-after',
    vary: 'origin',
  };
}

function servirArquivo(caminhoUrl, res) {
  const relativo = caminhoUrl === '/' ? 'index.html' : decodeURIComponent(caminhoUrl).replace(/^\/+/, '');
  const arquivo = path.resolve(PASTA_PUBLICA, relativo);
  if (!arquivo.startsWith(PASTA_PUBLICA + path.sep)) return false;
  let conteudo;
  try {
    conteudo = fs.readFileSync(arquivo);
  } catch {
    return false;
  }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(arquivo)] || 'application/octet-stream' });
  res.end(conteudo);
  return true;
}

function criarApp(store) {
  const rotas = [];

  /** Registra uma rota. O handler recebe { params, query, corpo } e devolve { status?, corpo?, cabecalhos? }. */
  function rota(metodo, caminho, handler) {
    const chaves = [];
    const padrao = caminho.replace(/:(\w+)/g, (_, chave) => {
      chaves.push(chave);
      return '([^/]+)';
    });
    rotas.push({ metodo, regex: new RegExp(`^${padrao}/?$`), chaves, handler });
  }

  // ------------------------------------------------------------------ status
  rota('GET', '/api/health', () => ({
    corpo: {
      ok: true,
      servico: pacote.name,
      versao: pacote.version,
      banco: store.tipo,
      fontes: {
        shipxy: shipxy.configurada() ? 'configurada' : 'demo (defina SHIPXY_API_KEY)',
        etracking: etracking.descricao(),
      },
      portoPadrao: config.portoPadrao,
    },
  }));

  // ------------------------------------------------------------------ portos
  rota('GET', '/api/portos', async ({ query }) => {
    const busca = String(query.busca || '').trim();
    if (busca.length < 2) throw new ErroApi('Informe ao menos 2 letras em "busca", ex.: /api/portos?busca=santos.', { status: 400 });
    const max = Math.min(Math.max(Number(query.max) || 10, 1), 50);
    const r = await shipxy.buscarPortos(busca, max);
    return { corpo: { fonte: r.fonte, total: r.dados.length, portos: r.dados, ...(querBruto(query) ? { bruto: r.bruto } : {}) } };
  });

  // ------------------------------------------------------------------ navios
  rota('GET', '/api/navios/chegadas', async ({ query }) => {
    const porto = normalizarPorto(query.porto, config.portoPadrao);
    const dias = normalizarDias(query.dias, config.diasPadrao);
    const inicio = new Date();
    const fim = new Date(inicio.getTime() + dias * 24 * 3600 * 1000);
    const r = await shipxy.chegadasPrevistas(porto, inicio, fim);
    return {
      corpo: {
        porto,
        janela: { inicio: inicio.toISOString(), fim: fim.toISOString(), dias },
        fonte: r.fonte,
        total: r.dados.length,
        navios: r.dados,
        ...(querBruto(query) ? { bruto: r.bruto } : {}),
      },
    };
  });

  rota('GET', '/api/navios/:mmsi', async ({ params, query }) => {
    const mmsi = String(params.mmsi).trim();
    if (!/^\d{9}$/.test(mmsi)) throw new ErroApi('MMSI inválido: deve ter 9 dígitos.', { status: 400 });
    const r = await shipxy.buscarNavio(mmsi);
    return { corpo: { fonte: r.fonte, navio: r.dados, ...(querBruto(query) ? { bruto: r.bruto } : {}) } };
  });

  // ------------------------------------------------------------------ contêineres
  rota('GET', '/api/conteineres', async ({ query }) => {
    const situacao = query.situacao ? String(query.situacao) : undefined;
    const lista = (await store.listarConteineres({ situacao })).map(semBruto);
    return { corpo: { total: lista.length, conteineres: lista } };
  });

  rota('POST', '/api/conteineres', async ({ corpo }) => {
    const dados = corpo && typeof corpo === 'object' ? corpo : {};
    const numero = normalizarNumeroConteiner(dados.numero);
    const armador = normalizarArmador(dados.armador);
    const opcional = (v) => (v === undefined || v === null || v === '' ? undefined : String(v).trim());

    const existia = Boolean(await store.obterConteiner(numero));
    const conteiner = await store.salvarConteiner(numero, {
      armador,
      descricao: opcional(dados.descricao),
      perigoso: dados.perigoso === undefined ? undefined : Boolean(dados.perigoso),
      classeRisco: opcional(dados.classeRisco),
      navioMmsi: opcional(dados.navioMmsi),
      navioImo: opcional(dados.navioImo),
      navioNome: opcional(dados.navioNome),
      situacao: opcional(dados.situacao),
    });

    const resposta = {
      criado: !existia,
      conteiner: semBruto(conteiner),
      digitoVerificadorValido: digitoVerificadorValido(numero),
    };
    if (dados.sincronizar !== false && etracking.disponivel()) {
      try {
        resposta.sincronizacao = await sincronizar(store, numero);
      } catch (erro) {
        // O cadastro vale mesmo se o eTracking falhar agora; dá para sincronizar depois.
        resposta.sincronizacao = { sincronizado: false, erro: erro.message };
      }
    }
    return { status: existia ? 200 : 201, corpo: resposta };
  });

  rota('GET', '/api/conteineres/:numero', async ({ params, query }) => {
    const numero = normalizarNumeroConteiner(params.numero);
    const conteiner = await store.obterConteiner(numero);
    if (!conteiner) throw new ErroApi(`Contêiner ${numero} não está cadastrado.`, { status: 404 });
    const eventos = await store.listarEventos(numero);
    return { corpo: { conteiner: querBruto(query) ? conteiner : semBruto(conteiner), eventos } };
  });

  rota('DELETE', '/api/conteineres/:numero', async ({ params }) => {
    const numero = normalizarNumeroConteiner(params.numero);
    const removido = await store.removerConteiner(numero);
    if (!removido) throw new ErroApi(`Contêiner ${numero} não está cadastrado.`, { status: 404 });
    return { status: 204 };
  });

  // Consulta avulsa ao eTracking, sem gravar nada (útil para conferir o que a API devolve).
  rota('GET', '/api/conteineres/:numero/rastreio', async ({ params, query }) => {
    const numero = normalizarNumeroConteiner(params.numero);
    const armador = normalizarArmador(query.armador);
    const r = await etracking.rastrear(numero, armador);
    return {
      status: r.pronto ? 200 : 202,
      cabecalhos: r.pronto ? {} : { 'retry-after': String(r.tenteNovamenteEmSegundos) },
      corpo: {
        fonte: r.fonte,
        pronto: r.pronto,
        digitoVerificadorValido: digitoVerificadorValido(numero),
        ...(r.pronto
          ? { rastreio: r.dados }
          : { situacao: r.situacao, tenteNovamenteEmSegundos: r.tenteNovamenteEmSegundos }),
        ...(querBruto(query) ? { bruto: r.bruto } : {}),
      },
    };
  });

  rota('POST', '/api/conteineres/:numero/sincronizar', async ({ params, query }) => {
    const numero = normalizarNumeroConteiner(params.numero);
    const r = await sincronizar(store, numero, { incluirBruto: querBruto(query) });
    return {
      status: r.sincronizado ? 200 : 202,
      cabecalhos: r.sincronizado ? {} : { 'retry-after': String(r.tenteNovamenteEmSegundos) },
      corpo: r,
    };
  });

  // ------------------------------------------------------------------ previsão
  rota('GET', '/api/previsao-entrada', async ({ query }) => {
    const porto = normalizarPorto(query.porto, config.portoPadrao);
    const dias = normalizarDias(query.dias, config.diasPadrao);
    return { corpo: await preverEntrada(store, { porto, dias, incluirBruto: querBruto(query) }) };
  });

  // ------------------------------------------------------------------ despacho
  return async function app(req, res) {
    const cors = cabecalhosCors(req);
    const enviar = (status, corpo, extras = {}) => {
      const cabecalhos = { ...cors, ...extras };
      if (corpo === undefined) {
        res.writeHead(status, cabecalhos);
        return res.end();
      }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...cabecalhos });
      return res.end(JSON.stringify(corpo));
    };

    try {
      const url = new URL(req.url, 'http://localhost');
      const caminho = url.pathname;

      if (req.method === 'OPTIONS') return enviar(204);

      if (!caminho.startsWith('/api/')) {
        if (req.method === 'GET' && servirArquivo(caminho, res)) return undefined;
        return enviar(404, { erro: 'Página não encontrada.' });
      }

      const candidatas = rotas
        .map((r) => ({ r, achado: r.regex.exec(caminho) }))
        .filter((x) => x.achado);
      const escolhida = candidatas.find((x) => x.r.metodo === req.method);
      if (!escolhida) {
        if (candidatas.length) {
          return enviar(405, { erro: `Método ${req.method} não permitido em ${caminho}.` }, { allow: candidatas.map((x) => x.r.metodo).join(', ') });
        }
        return enviar(404, { erro: `Rota ${req.method} ${caminho} não existe.` });
      }

      const params = {};
      escolhida.r.chaves.forEach((chave, i) => {
        params[chave] = decodeURIComponent(escolhida.achado[i + 1]);
      });
      const query = Object.fromEntries(url.searchParams);
      const corpo = req.method === 'POST' ? await lerCorpo(req) : undefined;

      const resultado = (await escolhida.r.handler({ params, query, corpo })) || {};
      return enviar(resultado.status || 200, resultado.corpo, resultado.cabecalhos);
    } catch (erro) {
      if (erro instanceof ErroApi) {
        return enviar(erro.status, {
          erro: erro.message,
          ...(erro.fonte ? { fonte: erro.fonte } : {}),
          ...(erro.detalhes ? { detalhes: erro.detalhes } : {}),
        });
      }
      console.error(erro);
      return enviar(500, { erro: 'Erro interno no servidor.' });
    }
  };
}

module.exports = { criarApp };

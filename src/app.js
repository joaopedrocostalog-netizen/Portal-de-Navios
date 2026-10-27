'use strict';

// API HTTP do Portal de Navios, usando apenas o módulo http nativo do Node
// (sem framework, para manter poucas dependências).

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const pacote = require('../package.json');
const dss = require('./services/dss');
const btp = require('./services/btp');
const { preverEntrada } = require('./services/previsao');
const {
  ErroApi,
  digitoVerificadorValido,
  normalizarNumeroConteiner,
  normalizarArmador,
  normalizarDias,
  querBruto,
} = require('./util');

const PASTA_PUBLICA = path.join(__dirname, '..', 'public');
const LIMITE_CORPO = 100 * 1024;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function lerBuffer(req, limite) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on('data', (parte) => {
      tamanho += parte.length;
      if (tamanho > limite) {
        reject(new ErroApi(`Corpo da requisição muito grande (máximo ${Math.round(limite / 1024)} KB).`, { status: 413 }));
        req.destroy();
        return;
      }
      partes.push(parte);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

function lerCorpo(req) {
  return lerBuffer(req, LIMITE_CORPO).then((buffer) => {
    const texto = buffer.toString('utf8');
    if (!texto.trim()) return {};
    try {
      return JSON.parse(texto);
    } catch {
      throw new ErroApi('JSON inválido no corpo da requisição.', { status: 400 });
    }
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
  function rota(metodo, caminho, handler, opcoes = {}) {
    const chaves = [];
    const padrao = caminho.replace(/:(\w+)/g, (_, chave) => {
      chaves.push(chave);
      return '([^/]+)';
    });
    rotas.push({ metodo, regex: new RegExp(`^${padrao}/?$`), chaves, handler, opcoes });
  }

  // ------------------------------------------------------------------ status
  rota('GET', '/api/health', () => ({
    corpo: {
      ok: true,
      servico: pacote.name,
      versao: pacote.version,
      banco: store.tipo,
      dss: dss.configurado() ? 'configurado' : 'não configurado (defina NAVIOS_OF_DSS)',
      terminalPadrao: config.terminalPadrao || null,
    },
  }));

  // ------------------------------------------------------------------ DSS (Portal de Navios do TMS)
  rota('GET', '/api/dss/atracacoes', async ({ query }) => {
    const r = await dss.atracacoes();
    const terminal = query.terminal ? String(query.terminal).toLowerCase() : null;
    const lista = terminal ? r.dados.filter((a) => String(a.terminal || '').toLowerCase() === terminal) : r.dados;
    return {
      corpo: {
        fonte: r.fonte,
        timezone: 'UTC',
        total: lista.length,
        terminais: [...new Set(r.dados.map((a) => a.terminal).filter(Boolean))].sort(),
        atracacoes: lista,
        ...(querBruto(query) ? { bruto: r.bruto } : {}),
      },
    };
  });

  // ------------------------------------------------------------------ contêineres
  rota('GET', '/api/conteineres', async ({ query }) => {
    const situacao = query.situacao ? String(query.situacao) : undefined;
    const lista = await store.listarConteineres({ situacao });
    return { corpo: { total: lista.length, conteineres: lista } };
  });

  rota('POST', '/api/conteineres', async ({ corpo }) => {
    const dados = corpo && typeof corpo === 'object' ? corpo : {};
    const numero = normalizarNumeroConteiner(dados.numero);
    const armador = normalizarArmador(dados.armador);
    const opcional = (v) => (v === undefined || v === null || v === '' ? undefined : String(v).trim());

    const existia = Boolean(await store.obterConteiner(numero));
    const navioNome = opcional(dados.navioNome);
    if (!existia && !navioNome) {
      throw new ErroApi('Informe "navioNome" (como aparece no DSS) para o contêiner entrar na previsão.', { status: 400 });
    }
    const conteiner = await store.salvarConteiner(numero, {
      armador,
      descricao: opcional(dados.descricao),
      perigoso: dados.perigoso === undefined ? undefined : Boolean(dados.perigoso),
      classeRisco: opcional(dados.classeRisco),
      navioNome: navioNome ? navioNome.toUpperCase() : undefined,
      navioViagem: opcional(dados.navioViagem)?.toUpperCase(),
      situacao: opcional(dados.situacao),
    });

    return {
      status: existia ? 200 : 201,
      corpo: { criado: !existia, conteiner, digitoVerificadorValido: digitoVerificadorValido(numero) },
    };
  });

  rota('GET', '/api/conteineres/:numero', async ({ params }) => {
    const numero = normalizarNumeroConteiner(params.numero);
    const conteiner = await store.obterConteiner(numero);
    if (!conteiner) throw new ErroApi(`Contêiner ${numero} não está cadastrado.`, { status: 404 });
    return { corpo: { conteiner } };
  });

  rota('DELETE', '/api/conteineres/:numero', async ({ params }) => {
    const numero = normalizarNumeroConteiner(params.numero);
    const removido = await store.removerConteiner(numero);
    if (!removido) throw new ErroApi(`Contêiner ${numero} não está cadastrado.`, { status: 404 });
    return { status: 204 };
  });

  // ------------------------------------------------------------------ planilha da BTP
  // Corpo = o próprio arquivo (xlsx, xls em HTML ou CSV); nome do arquivo em ?nome=.
  rota(
    'POST',
    '/api/btp/planilha',
    async ({ query, corpo }) => {
      const nomeArquivo = query.nome ? String(query.nome).slice(0, 200) : null;
      const r = btp.importarPlanilha(corpo);
      const importacao = await store.salvarImportacaoBtp({ nomeArquivo, formato: r.formato, registros: r.registros });
      return {
        status: 201,
        corpo: {
          importadoEm: importacao.importadoEm,
          nomeArquivo,
          formato: r.formato,
          total: r.registros.length,
          porStatus: btp.contarStatus(r.registros),
          colunasReconhecidas: r.colunas,
          avisos: r.avisos,
        },
      };
    },
    { corpoBruto: true, limite: 10 * 1024 * 1024 },
  );

  rota('GET', '/api/btp/lineup', async () => {
    const imp = await store.ultimaImportacaoBtp();
    if (!imp) throw new ErroApi('Nenhuma planilha da BTP importada ainda.', { status: 404 });
    return { corpo: { ...imp, timezone: 'UTC', porStatus: btp.contarStatus(imp.registros) } };
  });

  rota('GET', '/api/btp/comparacao', async ({ query }) => {
    const imp = await store.ultimaImportacaoBtp();
    if (!imp) throw new ErroApi('Nenhuma planilha da BTP importada ainda.', { status: 404 });
    const atracacoes = await dss.atracacoes();
    const toleranciaHoras = query.tolerancia !== undefined ? Math.max(0, Number(query.tolerancia) || 0) : config.toleranciaHoras;
    return {
      corpo: {
        planilha: { importadoEm: imp.importadoEm, nomeArquivo: imp.nomeArquivo, total: imp.total },
        ...btp.compararComDss(imp.registros, atracacoes.dados, { toleranciaHoras }),
      },
    };
  });

  // ------------------------------------------------------------------ previsão
  rota('GET', '/api/previsao-entrada', async ({ query }) => {
    const dias = normalizarDias(query.dias, config.diasPadrao);
    const terminal = query.terminal !== undefined ? String(query.terminal).trim() : config.terminalPadrao;
    return { corpo: await preverEntrada(store, { dias, terminal: terminal || undefined, incluirBruto: querBruto(query) }) };
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
      let corpo;
      if (req.method === 'POST') {
        corpo = escolhida.r.opcoes.corpoBruto ? await lerBuffer(req, escolhida.r.opcoes.limite) : await lerCorpo(req);
      }

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

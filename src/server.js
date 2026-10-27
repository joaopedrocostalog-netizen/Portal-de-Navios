'use strict';

const http = require('node:http');
const config = require('./config');
const { criarArmazenamento } = require('./db');
const { criarApp } = require('./app');
const { iniciarTempoReal } = require('./realtime');
const dss = require('./services/dss');

/** Registra no log os NOMES (nunca os valores) das variáveis de configuração presentes. */
function registrarVariaveis() {
  const relevante = /DSS|NAVIOS|DATABASE|TERMINAL|DIAS_PADRAO|VERIFICAR/i;
  const ignorar = /^(RENDER|npm_|NODE_|PATH$|HOME$|HOSTNAME$|PWD$)/;
  const nomes = Object.keys(process.env).filter((n) => relevante.test(n) && !ignorar.test(n)).sort();
  console.log(`[diagnóstico] variáveis encontradas (só os nomes): ${nomes.join(', ') || 'nenhuma'}`);
  for (const nome of ['DSS_URL', 'NAVIOS_OF_DSS']) {
    const valor = String(process.env[nome] || '').trim();
    if (!valor) continue;
    if (/^https?:\/\//i.test(valor)) {
      const url = new URL(valor);
      const credenciais = url.username ? ', com usuário embutido na URL' : '';
      console.log(`[diagnóstico] ${nome} é uma URL: ${url.protocol}//${url.host}${url.pathname}${credenciais}`);
    } else {
      console.log(`[diagnóstico] ${nome} não é uma URL (${valor.length} caracteres); o DSS precisa do endereço completo do endpoint.`);
    }
  }
  console.log(
    `[diagnóstico] dss: ${dss.configurado() ? `configurado (autenticação: ${dss.prepararRequisicao().autenticacao})` : 'não configurado'}`,
  );
}

function resumir(objeto) {
  const texto = JSON.stringify(objeto ?? {});
  return texto.length > 500 ? `${texto.slice(0, 500)}…` : texto;
}

/** Consulta o DSS ao iniciar e registra no log o que ele devolveu. */
async function verificarDss() {
  if (!dss.configurado() || !config.verificarFontes) return;
  try {
    const r = await dss.atracacoes();
    const terminais = [...new Set(r.dados.map((a) => a.terminal).filter(Boolean))].join(', ');
    const exemplos = r.dados
      .slice(0, 3)
      .map((a) => `${a.navio} v.${a.viagem} (${a.terminal}, chegada ${a.datas.prevChegada}, atracação ${a.datas.atracacao || a.datas.prevAtracacao})`)
      .join('; ');
    console.log(`[diagnóstico] DSS OK: ${r.dados.length} atracações. Terminais: ${terminais || '-'}. ${exemplos}`);
  } catch (erro) {
    console.log(`[diagnóstico] DSS falhou: ${erro.message} ${resumir(erro.detalhes)}`);
  }
}

async function iniciar({ porta = config.porta, store = criarArmazenamento() } = {}) {
  await store.iniciar();

  const app = criarApp(store);
  const servidor = http.createServer(app);
  const tempoReal = iniciarTempoReal(servidor, store);

  await new Promise((resolve) => servidor.listen(porta, resolve));
  const { port } = servidor.address();
  console.log(`Portal de Navios ouvindo na porta ${port} (banco: ${store.tipo}).`);
  if (require.main === module) {
    registrarVariaveis();
    verificarDss().catch((erro) => console.log(`[diagnóstico] falha inesperada: ${erro.message}`));
  }

  async function encerrar() {
    tempoReal.encerrar();
    await new Promise((resolve) => servidor.close(resolve));
    await store.encerrar();
  }

  return { servidor, porta: port, store, encerrar };
}

if (require.main === module) {
  iniciar()
    .then(({ encerrar }) => {
      const sair = () => encerrar().finally(() => process.exit(0));
      process.on('SIGTERM', sair);
      process.on('SIGINT', sair);
    })
    .catch((erro) => {
      console.error('Falha ao iniciar o servidor:', erro);
      process.exit(1);
    });
}

module.exports = { iniciar };

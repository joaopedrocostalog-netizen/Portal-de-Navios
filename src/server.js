'use strict';

const http = require('node:http');
const config = require('./config');
const { criarArmazenamento } = require('./db');
const { criarApp } = require('./app');
const { iniciarTempoReal } = require('./realtime');
const demo = require('./services/demo');
const shipxy = require('./services/shipxy');
const { sincronizar } = require('./services/conteineres');

const etracking = require('./services/etracking');
const dss = require('./services/dss');

const DIA = 24 * 3600 * 1000;

/** Registra no log os NOMES (nunca os valores) das variáveis de configuração presentes. */
function registrarVariaveis() {
  const relevante = /KEY|TOKEN|SECRET|SENHA|PASS|API|DSS|DATABASE|PORTO|URL/i;
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
    `[diagnóstico] dss: ${dss.configurado() ? `configurado (autenticação: ${dss.prepararRequisicao().autenticacao})` : 'não configurado'}` +
      ` | shipxy: ${shipxy.configurada() ? 'configurada' : 'não configurada'} | eTracking: ${etracking.descricao()}` +
      `${config.modoDemo ? ' | MODO DEMONSTRAÇÃO' : ''}`,
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

/** Faz consultas pequenas à Shipxy ao iniciar e registra no log se a chave e o código do porto funcionam. */
async function verificarShipxy() {
  if (!shipxy.configurada() || !config.verificarFontes) return;
  for (const termo of [...new Set([config.portoPadrao, config.portoNome])]) {
    try {
      const r = await shipxy.buscarPortos(termo, 5);
      const lista = r.dados.map((p) => `${p.codigo} ${p.nome} (${p.pais})`).join('; ');
      console.log(`[diagnóstico] Shipxy SearchPort "${termo}": ${lista || 'nenhum porto encontrado'}`);
    } catch (erro) {
      console.log(`[diagnóstico] Shipxy SearchPort "${termo}" falhou: ${erro.message} ${JSON.stringify(erro.detalhes || {})}`);
    }
  }
  try {
    const agora = new Date();
    const r = await shipxy.chegadasPrevistas(config.portoPadrao, agora, new Date(agora.getTime() + 7 * DIA));
    const exemplos = r.dados.slice(0, 3).map((n) => `${n.nome} (MMSI ${n.mmsi}, ETA ${n.eta})`).join('; ');
    console.log(`[diagnóstico] Shipxy GetETAShips ${config.portoPadrao} 7 dias: OK, ${r.dados.length} navios. ${exemplos}`);
  } catch (erro) {
    console.log(`[diagnóstico] Shipxy GetETAShips ${config.portoPadrao} falhou: ${erro.message} ${JSON.stringify(erro.detalhes || {})}`);
  }
}

async function iniciar({ porta = config.porta, store = criarArmazenamento() } = {}) {
  await store.iniciar();

  // Em modo demonstração e sem banco, cadastra contêineres de exemplo para a previsão já mostrar algo.
  if (store.tipo === 'memoria' && config.modoDemo) {
    for (const c of demo.CONTEINERES) {
      const navio = demo.NAVIOS[c.navio];
      await store.salvarConteiner(c.numero, {
        armador: c.armador,
        descricao: c.descricao,
        perigoso: Boolean(c.perigoso),
        classeRisco: c.classeRisco,
        navioMmsi: navio.mmsi,
        navioImo: navio.imo,
        navioNome: navio.nome,
      });
      await sincronizar(store, c.numero); // preenche o ETA do eTracking (demo) para a previsão comparar
    }
  }

  const app = criarApp(store);
  const servidor = http.createServer(app);
  const tempoReal = iniciarTempoReal(servidor, store);

  await new Promise((resolve) => servidor.listen(porta, resolve));
  const { port } = servidor.address();
  console.log(`Portal de Navios ouvindo na porta ${port} (banco: ${store.tipo}).`);
  if (require.main === module) {
    registrarVariaveis();
    verificarDss()
      .then(verificarShipxy)
      .catch((erro) => console.log(`[diagnóstico] falha inesperada: ${erro.message}`));
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

'use strict';

const http = require('node:http');
const config = require('./config');
const { criarArmazenamento } = require('./db');
const { criarApp } = require('./app');
const { iniciarTempoReal } = require('./realtime');
const demo = require('./services/demo');
const shipxy = require('./services/shipxy');
const { sincronizar } = require('./services/conteineres');

async function iniciar({ porta = config.porta, store = criarArmazenamento() } = {}) {
  await store.iniciar();

  // Sem banco e sem chave da Shipxy, cadastra contêineres de exemplo para a previsão já mostrar algo.
  if (store.tipo === 'memoria' && !shipxy.configurada()) {
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

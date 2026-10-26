'use strict';

// Ponto de encaixe do eTracking (situação e ETA de cada contêiner vindos do armador ou do terminal).
//
// A VesselFinder foi removida por ser paga. Enquanto nenhuma fonte estiver ligada aqui, o contêiner
// é associado ao navio pelos dados informados no cadastro (navioNome, navioMmsi ou navioImo)
// e a previsão de entrada usa o ETA do navio vindo da Shipxy.
//
// Para ligar uma nova fonte, implemente `rastrear` devolvendo { fonte, pronto: true, dados, bruto }
// com `dados` no formato abaixo e faça `configurada()` retornar true quando a chave existir:
//   {
//     numero, armador, scac, origem, destino, progresso, localAtual,
//     navio: { nome, imo, mmsi, posicao: { lat, lon }, velocidade, rumo } | null,
//     eventos: [{ porto, locode, evento, dataHora, realizado, navio }],
//     etaDestino, locodeDestino
//   }

const config = require('../config');
const demo = require('./demo');
const { ErroApi } = require('../util');

/** Existe uma fonte real de eTracking configurada? */
function configurada() {
  return false;
}

/** Há algo para consultar (fonte real ou modo demonstração)? */
function disponivel() {
  return configurada() || config.modoDemo;
}

function descricao() {
  if (configurada()) return 'configurada';
  return config.modoDemo ? 'demo' : 'nenhuma fonte ligada (navio informado no cadastro)';
}

/**
 * @param {string} numero   número do contêiner
 * @param {string} armador  SCAC ou AUTO
 * @param {object} contexto dados já cadastrados (ex.: navioMmsi), úteis para algumas fontes
 */
async function rastrear(numero, armador = 'AUTO', contexto = {}) {
  if (config.modoDemo) {
    return {
      fonte: 'demo',
      pronto: true,
      dados: demo.rastreioDemo(numero, armador, config.portoPadrao, contexto.navioMmsi),
      bruto: null,
    };
  }
  throw new ErroApi(
    'Nenhuma fonte de eTracking está ligada. Informe o navio do contêiner no cadastro (navioNome, navioMmsi ou navioImo).',
    { status: 501, fonte: 'etracking' },
  );
}

module.exports = { configurada, disponivel, descricao, rastrear };

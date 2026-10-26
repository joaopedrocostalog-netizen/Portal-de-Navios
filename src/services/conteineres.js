'use strict';

// Regras de contêineres: cadastrar para monitorar e, se houver fonte de eTracking, sincronizar.

const etracking = require('./etracking');
const { ErroApi } = require('../util');

function dataOuNulo(valor) {
  return valor && !Number.isNaN(Date.parse(valor)) ? valor : null;
}

/**
 * Consulta o eTracking e grava o resultado no contêiner.
 * Se a fonte ainda estiver processando (pronto: false), nada é gravado e o retorno indica quando tentar de novo.
 */
async function sincronizar(store, numero, { incluirBruto = false } = {}) {
  const existente = await store.obterConteiner(numero);
  if (!existente) {
    throw new ErroApi(`Contêiner ${numero} não está cadastrado. Cadastre com POST /api/conteineres.`, {
      status: 404,
    });
  }

  const resultado = await etracking.rastrear(numero, existente.armador || 'AUTO', existente);
  if (!resultado.pronto) {
    return {
      sincronizado: false,
      fonte: resultado.fonte,
      situacao: resultado.situacao,
      tenteNovamenteEmSegundos: resultado.tenteNovamenteEmSegundos,
      conteiner: semBruto(existente),
      ...(incluirBruto ? { bruto: resultado.bruto } : {}),
    };
  }

  const r = resultado.dados;
  const conteiner = await store.salvarConteiner(numero, {
    // Mantém o que o usuário cadastrou se o eTracking não trouxer o dado.
    navioMmsi: r.navio?.mmsi || existente.navioMmsi,
    navioImo: r.navio?.imo || existente.navioImo,
    navioNome: r.navio?.nome || existente.navioNome,
    portoDestino: r.destino || existente.portoDestino,
    locodeDestino: r.locodeDestino || existente.locodeDestino,
    etaEtracking: dataOuNulo(r.etaDestino),
    progresso: Number.isFinite(Number(r.progresso)) ? Math.round(Number(r.progresso)) : null,
    localAtual: r.localAtual,
    situacao: Number(r.progresso) >= 100 ? 'entregue' : existente.situacao,
    ultimoRastreioEm: new Date().toISOString(),
    rastreioBruto: resultado.bruto,
  });
  await store.registrarEventos(numero, r.eventos, resultado.fonte);

  return {
    sincronizado: true,
    fonte: resultado.fonte,
    conteiner: semBruto(conteiner),
    rastreio: r,
    ...(incluirBruto ? { bruto: resultado.bruto } : {}),
  };
}

function semBruto(conteiner) {
  if (!conteiner) return conteiner;
  const { rastreioBruto, ...resto } = conteiner;
  return resto;
}

module.exports = { sincronizar, semBruto };

'use strict';

/** Erro de negócio ou de fonte externa, já com o status HTTP que a nossa API deve devolver. */
class ErroApi extends Error {
  constructor(mensagem, { status = 500, fonte = null, detalhes = null } = {}) {
    super(mensagem);
    this.name = 'ErroApi';
    this.status = status;
    this.fonte = fonte;
    this.detalhes = detalhes;
  }
}

/**
 * Converte o que as APIs devolvem em data ISO 8601.
 * Aceita Unix em segundos ou milissegundos (número ou texto) e textos de data.
 * Se não reconhecer, devolve o valor original para não perder informação.
 */
function paraIso(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  if (typeof valor === 'number' || /^\d+$/.test(String(valor))) {
    const n = Number(valor);
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? String(valor) : d.toISOString();
  }
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? String(valor) : d.toISOString();
}

const PADRAO_CONTEINER = /^[A-Z]{4}\d{7}$/;
const PADRAO_SCAC = /^[A-Z]{4}$/;
const PADRAO_LOCODE = /^[A-Z]{2}[A-Z0-9]{3}$/;

const VALORES_LETRAS = (() => {
  // ISO 6346: A=10 e pula os múltiplos de 11 (11, 22, 33).
  const mapa = {};
  let v = 10;
  for (const letra of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v += 1;
    mapa[letra] = v;
    v += 1;
  }
  return mapa;
})();

/** Valida o dígito verificador ISO 6346 de um número de contêiner (ex.: MSCU1234566). */
function digitoVerificadorValido(numero) {
  if (!PADRAO_CONTEINER.test(numero)) return false;
  let soma = 0;
  for (let i = 0; i < 10; i += 1) {
    const c = numero[i];
    const valor = i < 4 ? VALORES_LETRAS[c] : Number(c);
    soma += valor * 2 ** i;
  }
  return (soma % 11) % 10 === Number(numero[10]);
}

function normalizarNumeroConteiner(valor) {
  const numero = String(valor || '').replace(/[\s-]/g, '').toUpperCase();
  if (!PADRAO_CONTEINER.test(numero)) {
    throw new ErroApi(
      'Número de contêiner inválido. Use 4 letras + 7 dígitos, por exemplo MSCU1234566.',
      { status: 400 },
    );
  }
  return numero;
}

function normalizarArmador(valor) {
  const scac = String(valor || 'AUTO').trim().toUpperCase();
  if (scac !== 'AUTO' && !PADRAO_SCAC.test(scac)) {
    throw new ErroApi('Código do armador (SCAC) inválido. Use 4 letras, ex.: MSCU, ou AUTO.', {
      status: 400,
    });
  }
  return scac;
}

function normalizarPorto(valor, padrao) {
  const porto = String(valor || padrao || '').trim().toUpperCase();
  if (!PADRAO_LOCODE.test(porto)) {
    throw new ErroApi('Código de porto inválido. Use o código de 5 caracteres da Shipxy (descubra em /api/portos?busca=santos).', {
      status: 400,
    });
  }
  return porto;
}

function normalizarDias(valor, padrao) {
  const dias = valor === undefined || valor === '' ? padrao : Number(valor);
  if (!Number.isInteger(dias) || dias < 1 || dias > 30) {
    throw new ErroApi('O parâmetro "dias" deve ser um número inteiro entre 1 e 30.', { status: 400 });
  }
  return dias;
}

/** `?incluirBruto=true` anexa a resposta original da fonte, para conferir o que a API devolve. */
function querBruto(query) {
  return ['1', 'true', 'sim'].includes(String(query?.incluirBruto || '').toLowerCase());
}

module.exports = {
  ErroApi,
  paraIso,
  digitoVerificadorValido,
  normalizarNumeroConteiner,
  normalizarArmador,
  normalizarPorto,
  normalizarDias,
  querBruto,
};

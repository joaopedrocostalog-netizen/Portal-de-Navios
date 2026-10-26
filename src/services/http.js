'use strict';

const { ErroApi } = require('../util');

/**
 * GET que devolve { status, corpo } sem lançar erro para códigos HTTP != 200,
 * para que cada serviço decida o que cada código significa.
 * `rotulo` é o que aparece em mensagens de erro (nunca a URL, que pode conter a chave).
 */
async function obterJson(url, { timeoutMs, rotulo }) {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), timeoutMs);
  try {
    const resposta = await fetch(url, {
      signal: controle.signal,
      headers: { accept: 'application/json' },
    });
    const texto = await resposta.text();
    let corpo = null;
    if (texto) {
      try {
        corpo = JSON.parse(texto);
      } catch {
        corpo = { textoBruto: texto.slice(0, 2000) };
      }
    }
    return { status: resposta.status, corpo };
  } catch (erro) {
    if (erro.name === 'AbortError') {
      throw new ErroApi(`${rotulo}: tempo de resposta esgotado (${timeoutMs} ms).`, {
        status: 504,
        fonte: rotulo,
      });
    }
    throw new ErroApi(`${rotulo}: falha de conexão (${erro.message}).`, {
      status: 502,
      fonte: rotulo,
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { obterJson };

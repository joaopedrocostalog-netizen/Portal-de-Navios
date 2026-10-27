'use strict';

// Atualizações em tempo real por WebSocket no caminho /ws (mesma porta da API, como o Render exige).
//
// Mensagens do cliente:
//   { "acao": "acompanhar-previsao", "dias": 7, "terminal": "btp" }
//   { "acao": "parar", "chave": "previsao:btp:7" }
//
// Cada assunto é consultado uma única vez por intervalo, não importa quantos clientes
// estejam ouvindo, para não sobrecarregar o DSS.

const { WebSocketServer } = require('ws');
const config = require('./config');
const { preverEntrada } = require('./services/previsao');
const { normalizarDias } = require('./util');

function iniciarTempoReal(servidorHttp, store) {
  const wss = new WebSocketServer({ server: servidorHttp, path: '/ws' });
  const assuntos = new Map(); // chave -> { timer, clientes: Set, consultar }

  function enviar(ws, mensagem) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(mensagem));
  }

  async function publicar(chave) {
    const assunto = assuntos.get(chave);
    if (!assunto) return;
    let mensagem;
    try {
      mensagem = { tipo: 'atualizacao', chave, em: new Date().toISOString(), dados: await assunto.consultar() };
    } catch (erro) {
      mensagem = { tipo: 'erro', chave, mensagem: erro.message };
    }
    for (const ws of assunto.clientes) enviar(ws, mensagem);
  }

  function assinar(ws, chave, consultar) {
    let assunto = assuntos.get(chave);
    if (!assunto) {
      assunto = { clientes: new Set(), consultar, timer: setInterval(() => publicar(chave), config.intervaloTempoRealMs) };
      assuntos.set(chave, assunto);
    }
    assunto.clientes.add(ws);
    ws.assinaturas.add(chave);
    enviar(ws, { tipo: 'inscrito', chave, intervaloMs: config.intervaloTempoRealMs });
    publicar(chave); // primeira atualização imediata
  }

  function cancelar(ws, chave) {
    const assunto = assuntos.get(chave);
    ws.assinaturas.delete(chave);
    if (!assunto) return;
    assunto.clientes.delete(ws);
    if (assunto.clientes.size === 0) {
      clearInterval(assunto.timer);
      assuntos.delete(chave);
    }
  }

  wss.on('connection', (ws) => {
    ws.assinaturas = new Set();
    enviar(ws, { tipo: 'bem-vindo', acoes: ['acompanhar-previsao', 'parar'] });

    ws.on('message', (bruto) => {
      let msg;
      try {
        msg = JSON.parse(String(bruto));
      } catch {
        return enviar(ws, { tipo: 'erro', mensagem: 'Mensagem precisa ser JSON.' });
      }
      try {
        if (msg.acao === 'acompanhar-previsao') {
          const dias = normalizarDias(msg.dias, config.diasPadrao);
          const terminal = String(msg.terminal ?? config.terminalPadrao ?? '').trim().toLowerCase();
          assinar(ws, `previsao:${terminal || 'todos'}:${dias}`, () =>
            preverEntrada(store, { dias, terminal: terminal || undefined }),
          );
        } else if (msg.acao === 'parar') {
          cancelar(ws, String(msg.chave || ''));
          enviar(ws, { tipo: 'cancelado', chave: msg.chave });
        } else {
          throw new Error('Ação desconhecida. Use "acompanhar-previsao" ou "parar".');
        }
      } catch (erro) {
        enviar(ws, { tipo: 'erro', mensagem: erro.message });
      }
    });

    ws.on('close', () => {
      for (const chave of [...ws.assinaturas]) cancelar(ws, chave);
    });
  });

  return {
    encerrar() {
      for (const assunto of assuntos.values()) clearInterval(assunto.timer);
      assuntos.clear();
      wss.close();
    },
  };
}

module.exports = { iniciarTempoReal };

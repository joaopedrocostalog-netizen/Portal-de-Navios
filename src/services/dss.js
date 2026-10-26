'use strict';

// DSS (TMS) – endpoint "Portal de Navios" (módulo tms_integr_portal_navios).
// Devolve as atracações por terminal. Todas as datas vêm em UTC no formato "AAAA-MM-DD HH:MM:SS".
//
// Respostas documentadas:
//   200 { status, apiVersion, mensagemErro, timezone, qtd_registros, registros: [...] }
//   401 autenticação não informada ou usuário/senha inválidos
//   403 cliente sem o módulo tms_integr_portal_navios
//   500 erro inesperado / falha de comunicação com o DSS
//
// Configuração: DSS_URL (ou NAVIOS_OF_DSS) com o endereço completo do endpoint.
// Login por Basic Auth em DSS_USUARIO / DSS_SENHA (ou embutido na URL: https://usuario:senha@host/...).
// Se o DSS usar token, DSS_TOKEN vai no cabeçalho "Authorization: Bearer".

const config = require('../config');
const { obterJson } = require('./http');
const { ErroApi } = require('../util');
const demo = require('./demo');

const ROTULO = 'DSS';

function configurado() {
  return Boolean(config.dssUrl);
}

/** Separa usuário/senha embutidos na URL (o fetch do Node não aceita credenciais na URL). */
function prepararRequisicao() {
  const url = new URL(config.dssUrl);
  const cabecalhos = {};
  let usuario = config.dssUsuario;
  let senha = config.dssSenha;
  if (url.username) {
    usuario = usuario || decodeURIComponent(url.username);
    senha = senha || decodeURIComponent(url.password);
    url.username = '';
    url.password = '';
  }
  if (config.dssToken) cabecalhos.authorization = `Bearer ${config.dssToken}`;
  else if (usuario) cabecalhos.authorization = `Basic ${Buffer.from(`${usuario}:${senha}`).toString('base64')}`;
  return { url, cabecalhos, autenticacao: cabecalhos.authorization ? cabecalhos.authorization.split(' ')[0] : 'nenhuma' };
}

/** "2024-07-20 18:00:00" (UTC) -> "2024-07-20T18:00:00.000Z". Valores vazios ou inválidos viram null. */
function dataUtc(valor) {
  const texto = String(valor ?? '').trim();
  if (!texto) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(texto);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3] || ':00'}${m[5] || 'Z'}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function textoOuNulo(valor) {
  const t = String(valor ?? '').trim();
  return t ? t : null;
}

/** Converte um registro do DSS para o formato do Portal de Navios. */
function normalizarAtracacao(r) {
  const datas = {
    deadline: dataUtc(r.data_deadline),
    prevChegada: dataUtc(r.data_prev_chegada),
    prevAtracacao: dataUtc(r.data_prev_atracacao),
    atracacao: dataUtc(r.data_atracacao),
    prevSaida: dataUtc(r.data_prev_saida),
    prevAberturaGate: dataUtc(r.data_prev_abertura_gate),
    aberturaGate: dataUtc(r.data_abertura_gate),
    prevLiberacaoDry: dataUtc(r.data_prev_lib_dry),
    liberacaoDry: dataUtc(r.data_lib_dry),
    prevLiberacaoReefer: dataUtc(r.data_prev_lib_reefer),
    liberacaoReefer: dataUtc(r.data_lib_reefer),
  };
  // Data de referência para ordenar e filtrar: o que já aconteceu vale mais que a previsão.
  const referencia = datas.atracacao || datas.prevAtracacao || datas.prevChegada || datas.deadline;
  return {
    navio: textoOuNulo(r.navio),
    viagem: textoOuNulo(r.nro_viagem),
    armador: textoOuNulo(r.armador),
    terminal: textoOuNulo(r.terminal),
    situacao: datas.atracacao ? 'atracado' : 'previsto',
    referencia,
    datas,
  };
}

/**
 * Consulta as atracações no DSS.
 * Retorna { fonte, dados, bruto }.
 */
async function atracacoes() {
  if (!configurado()) {
    if (config.modoDemo) return { fonte: 'demo', dados: demo.atracacoesDemo(), bruto: null };
    throw new ErroApi('DSS não configurado: defina DSS_URL (ou NAVIOS_OF_DSS) com o endereço do endpoint.', {
      status: 503,
      fonte: 'dss',
    });
  }

  const { url, cabecalhos } = prepararRequisicao();
  const { status, corpo } = await obterJson(url, { timeoutMs: config.timeoutHttpMs, rotulo: ROTULO, cabecalhos });
  const mensagem = corpo?.mensagemErro || corpo?.textoBruto?.slice(0, 200) || '';

  if (status === 401) {
    throw new ErroApi(`DSS: autenticação recusada (${mensagem || 'usuário ou senha inválidos'}). Confira DSS_USUARIO e DSS_SENHA.`, {
      status: 502,
      fonte: 'dss',
      detalhes: corpo,
    });
  }
  if (status === 403) {
    throw new ErroApi(`DSS: cliente não habilitado (${mensagem || 'falta o módulo tms_integr_portal_navios'}).`, {
      status: 502,
      fonte: 'dss',
      detalhes: corpo,
    });
  }
  if (status !== 200 || !corpo || !Array.isArray(corpo.registros)) {
    throw new ErroApi(`DSS respondeu HTTP ${status}${mensagem ? `: ${mensagem}` : ''}.`, {
      status: 502,
      fonte: 'dss',
      detalhes: corpo,
    });
  }

  const dados = corpo.registros
    .map(normalizarAtracacao)
    .sort((a, b) => String(a.referencia || '9999').localeCompare(String(b.referencia || '9999')));
  return { fonte: 'dss', dados, bruto: corpo };
}

module.exports = { configurado, atracacoes, normalizarAtracacao, dataUtc, prepararRequisicao };

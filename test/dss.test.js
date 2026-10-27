'use strict';

// Leitura da API Portal de Navios do DSS com respostas simuladas no formato da documentação.
// Usuário e senha embutidos na URL, uma das formas aceitas em NAVIOS_OF_DSS.
process.env.NAVIOS_OF_DSS = 'https://integra%40empresa:s3nh%40@tms.exemplo.com.br/api/v1/portal-navios';
process.env.DSS_USUARIO = '';
process.env.DSS_TOKEN = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const dss = require('../src/services/dss');

const fetchOriginal = global.fetch;
let resposta;
let ultima;

global.fetch = async (url, opcoes = {}) => {
  ultima = { url: String(url), cabecalhos: opcoes.headers };
  return new Response(typeof resposta.corpo === 'string' ? resposta.corpo : JSON.stringify(resposta.corpo), { status: resposta.status });
};

test.after(() => {
  global.fetch = fetchOriginal;
});

test('datas do DSS em UTC viram ISO 8601', () => {
  assert.equal(dss.dataUtc('2024-07-20 18:00:00'), '2024-07-20T18:00:00.000Z');
  assert.equal(dss.dataUtc('2024-07-20 18:00'), '2024-07-20T18:00:00.000Z');
  assert.equal(dss.dataUtc('2024-07-20T18:00:00Z'), '2024-07-20T18:00:00.000Z');
  assert.equal(dss.dataUtc(''), null);
  assert.equal(dss.dataUtc('string'), null);
  assert.equal(dss.dataUtc(null), null);
});

test('usuário e senha da URL viram Basic Auth e saem da URL', async () => {
  resposta = {
    status: 200,
    corpo: {
      status: 200, apiVersion: 1, mensagemErro: '', timezone: 'UTC', qtd_registros: 1,
      registros: [{
        navio: 'MSC INSA', nro_viagem: 'NA642R', armador: 'MSC', terminal: 'btp', timezone: 'UTC',
        data_deadline: '2026-10-25 12:00:00', data_atracacao: '', data_prev_chegada: '2026-10-22 16:00:00',
        data_prev_atracacao: '2026-10-27 19:00:00', data_prev_saida: '2026-10-28 20:00:00',
        data_prev_abertura_gate: '2026-10-24 13:00:00', data_abertura_gate: '2026-10-24 13:00:00',
        data_prev_lib_dry: '', data_lib_dry: '', data_prev_lib_reefer: '', data_lib_reefer: '',
      }],
    },
  };
  const r = await dss.atracacoes();
  assert.equal(ultima.url, 'https://tms.exemplo.com.br/api/v1/portal-navios');
  assert.equal(ultima.cabecalhos.authorization, `Basic ${Buffer.from('integra@empresa:s3nh@').toString('base64')}`);
  assert.equal(r.fonte, 'dss');
  assert.deepEqual(r.dados[0], {
    navio: 'MSC INSA',
    viagem: 'NA642R',
    armador: 'MSC',
    terminal: 'btp',
    situacao: 'previsto',
    referencia: '2026-10-27T19:00:00.000Z',
    datas: {
      deadline: '2026-10-25T12:00:00.000Z',
      prevChegada: '2026-10-22T16:00:00.000Z',
      prevAtracacao: '2026-10-27T19:00:00.000Z',
      atracacao: null,
      prevSaida: '2026-10-28T20:00:00.000Z',
      prevAberturaGate: '2026-10-24T13:00:00.000Z',
      aberturaGate: '2026-10-24T13:00:00.000Z',
      prevLiberacaoDry: null,
      liberacaoDry: null,
      prevLiberacaoReefer: null,
      liberacaoReefer: null,
    },
  });
});

test('erros 401, 403 e 500 do DSS chegam com a mensagem dele', async () => {
  resposta = { status: 401, corpo: { status: 401, apiVersion: 1, mensagemErro: 'Usuário ou senha inválidos' } };
  await assert.rejects(dss.atracacoes(), /Usuário ou senha inválidos.*DSS_USUARIO/);
  resposta = { status: 403, corpo: { status: 403, apiVersion: 1, mensagemErro: 'Instale o módulo tms_integr_portal_navios para utilizar.' } };
  await assert.rejects(dss.atracacoes(), /tms_integr_portal_navios/);
  resposta = { status: 500, corpo: { status: 500, apiVersion: 1, mensagemErro: 'Erro ao acessar o sistema TMS' } };
  await assert.rejects(dss.atracacoes(), /HTTP 500: Erro ao acessar o sistema TMS/);
  resposta = { status: 200, corpo: '<html>login</html>' };
  await assert.rejects(dss.atracacoes(), /HTTP 200: <html>login/);
});

test('falha de rede não expõe usuário nem senha', async () => {
  global.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  await assert.rejects(dss.atracacoes(), (e) => {
    assert.doesNotMatch(e.message, /s3nh|integra/);
    assert.equal(e.status, 502);
    return true;
  });
});

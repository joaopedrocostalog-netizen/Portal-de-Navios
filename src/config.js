'use strict';

// Todas as configurações vêm de variáveis de ambiente (no Render: aba "Environment").
// Nenhuma chave é obrigatória: sem DSS e sem Shipxy, o sistema todo responde em modo demonstração.

function numero(valor, padrao) {
  if (valor === undefined || valor === '') return padrao;
  const n = Number(valor);
  return Number.isFinite(n) ? n : padrao;
}

function urlOuVazio(valor) {
  const texto = String(valor || '').trim();
  return /^https?:\/\//i.test(texto) ? texto : '';
}

function carregar() {
  return {
    porta: numero(process.env.PORT, 3000),

    // trim(): espaços ou quebras de linha coladas junto com a chave fazem a Shipxy responder "Key不存在".
    shipxyKey: (process.env.SHIPXY_API_KEY || '').trim(),
    shipxyBaseUrl: process.env.SHIPXY_BASE_URL || 'https://api.shipxy.com/apicall/v3',

    // DSS (TMS) – endpoint "Portal de Navios" (módulo tms_integr_portal_navios): atracações por terminal.
    // Endereço completo do endpoint em DSS_URL (ou NAVIOS_OF_DSS) e login em DSS_USUARIO / DSS_SENHA.
    dssUrl: urlOuVazio(process.env.DSS_URL || process.env.NAVIOS_OF_DSS),
    dssUsuario: (process.env.DSS_USUARIO || '').trim(),
    dssSenha: process.env.DSS_SENHA || '',
    dssToken: (process.env.DSS_TOKEN || '').trim(),

    // Sem nenhuma fonte real de navios, tudo vira demonstração.
    modoDemo:
      !(process.env.SHIPXY_API_KEY || '').trim() &&
      !urlOuVazio(process.env.DSS_URL || process.env.NAVIOS_OF_DSS),

    databaseUrl: process.env.DATABASE_URL || '',
    databaseSsl: process.env.DATABASE_SSL === 'true',

    // Código de porto da Shipxy (consulte /api/portos?busca=santos). A Shipxy usa códigos próprios,
    // que podem ser diferentes do UN/LOCODE oficial.
    portoPadrao: (process.env.PORTO_PADRAO || 'BRSSZ').toUpperCase(),
    // Nome usado no diagnóstico da inicialização para conferir o código do porto na Shipxy.
    portoNome: process.env.PORTO_NOME || 'Santos',
    verificarFontes: process.env.VERIFICAR_FONTES !== 'false',
    diasPadrao: numero(process.env.DIAS_PADRAO, 7),
    // Diferença (em horas) entre duas previsões de chegada (DSS × AIS da Shipxy, ou navio × eTracking)
    // a partir da qual a previsão aponta uma divergência para conferência.
    toleranciaDivergenciaHoras: numero(process.env.TOLERANCIA_DIVERGENCIA_HORAS, 24),

    intervaloTempoRealMs: numero(process.env.INTERVALO_TEMPO_REAL_MS, 60000),
    timeoutHttpMs: numero(process.env.TIMEOUT_HTTP_MS, 15000),
    corsOrigin: process.env.CORS_ORIGIN || '*',
  };
}

module.exports = carregar();
module.exports.carregar = carregar;

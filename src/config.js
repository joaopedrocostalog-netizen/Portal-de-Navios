'use strict';

// Todas as configurações vêm de variáveis de ambiente (no Render: aba "Environment").

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

    // DSS (TMS) – endpoint "Portal de Navios" (módulo tms_integr_portal_navios): atracações por terminal.
    // Endereço completo do endpoint em NAVIOS_OF_DSS (ou DSS_URL) e login em DSS_USUARIO / DSS_SENHA.
    dssUrl: urlOuVazio(process.env.DSS_URL || process.env.NAVIOS_OF_DSS),
    dssUsuario: (process.env.DSS_USUARIO || '').trim(),
    dssSenha: process.env.DSS_SENHA || '',
    dssToken: (process.env.DSS_TOKEN || '').trim(),

    databaseUrl: process.env.DATABASE_URL || '',
    databaseSsl: process.env.DATABASE_SSL === 'true',

    terminalPadrao: (process.env.TERMINAL_PADRAO || '').trim().toLowerCase(),
    diasPadrao: numero(process.env.DIAS_PADRAO, 7),
    // Diferença (em horas) entre DSS e planilha da BTP a partir da qual a comparação aponta divergência.
    toleranciaHoras: numero(process.env.TOLERANCIA_HORAS, 1),
    verificarFontes: process.env.VERIFICAR_FONTES !== 'false',

    intervaloTempoRealMs: numero(process.env.INTERVALO_TEMPO_REAL_MS, 60000),
    timeoutHttpMs: numero(process.env.TIMEOUT_HTTP_MS, 15000),
    corsOrigin: process.env.CORS_ORIGIN || '*',
  };
}

module.exports = carregar();
module.exports.carregar = carregar;

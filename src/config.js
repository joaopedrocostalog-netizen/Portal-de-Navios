'use strict';

// Todas as configurações vêm de variáveis de ambiente (no Render: aba "Environment").
// Nenhuma chave é obrigatória: sem a chave da Shipxy, o sistema todo responde em modo demonstração.

function numero(valor, padrao) {
  if (valor === undefined || valor === '') return padrao;
  const n = Number(valor);
  return Number.isFinite(n) ? n : padrao;
}

function carregar() {
  return {
    porta: numero(process.env.PORT, 3000),

    shipxyKey: process.env.SHIPXY_API_KEY || '',
    shipxyBaseUrl: process.env.SHIPXY_BASE_URL || 'https://api.shipxy.com/apicall/v3',

    // Sem chave da Shipxy não há dado real de navio: tudo vira demonstração.
    modoDemo: !process.env.SHIPXY_API_KEY,

    databaseUrl: process.env.DATABASE_URL || '',
    databaseSsl: process.env.DATABASE_SSL === 'true',

    // Código de porto da Shipxy (consulte /api/portos?busca=santos). A Shipxy usa códigos próprios,
    // que podem ser diferentes do UN/LOCODE oficial.
    portoPadrao: (process.env.PORTO_PADRAO || 'BRSSZ').toUpperCase(),
    // Nome usado no diagnóstico da inicialização para conferir o código do porto na Shipxy.
    portoNome: process.env.PORTO_NOME || 'Santos',
    verificarFontes: process.env.VERIFICAR_FONTES !== 'false',
    diasPadrao: numero(process.env.DIAS_PADRAO, 7),
    // Diferença (em horas) entre o ETA do navio e o ETA do eTracking que gera alerta de divergência.
    toleranciaDivergenciaHoras: numero(process.env.TOLERANCIA_DIVERGENCIA_HORAS, 24),

    intervaloTempoRealMs: numero(process.env.INTERVALO_TEMPO_REAL_MS, 60000),
    timeoutHttpMs: numero(process.env.TIMEOUT_HTTP_MS, 15000),
    corsOrigin: process.env.CORS_ORIGIN || '*',
  };
}

module.exports = carregar();
module.exports.carregar = carregar;

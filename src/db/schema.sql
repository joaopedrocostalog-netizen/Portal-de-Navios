-- Estrutura do banco do Portal de Navios (PostgreSQL).
-- É aplicada automaticamente quando o servidor inicia (comandos idempotentes).

CREATE TABLE IF NOT EXISTS conteineres (
  numero         VARCHAR(11) PRIMARY KEY,             -- ISO 6346: 4 letras + 7 dígitos
  armador        VARCHAR(4)  NOT NULL DEFAULT 'AUTO', -- SCAC do armador
  descricao      TEXT,
  perigoso       BOOLEAN     NOT NULL DEFAULT FALSE,  -- carga perigosa
  classe_risco   VARCHAR(50),
  navio_nome     VARCHAR(255),                         -- como aparece no DSS
  navio_viagem   VARCHAR(50),                          -- nro_viagem do DSS (opcional)
  situacao       VARCHAR(30) NOT NULL DEFAULT 'monitorando', -- monitorando | entregue | arquivado
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bancos criados por versões anteriores.
ALTER TABLE conteineres ADD COLUMN IF NOT EXISTS navio_viagem VARCHAR(50);

-- Planilhas da BTP importadas (a mais recente é a usada na previsão e na comparação com o DSS).
CREATE TABLE IF NOT EXISTS importacoes_btp (
  id            BIGSERIAL   PRIMARY KEY,
  importado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  nome_arquivo  TEXT,
  formato       VARCHAR(10),
  total         INTEGER     NOT NULL,
  registros     JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conteineres_situacao ON conteineres (situacao);
CREATE INDEX IF NOT EXISTS idx_conteineres_navio ON conteineres (navio_nome);

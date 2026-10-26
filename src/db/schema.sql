-- Estrutura do banco do Portal de Navios (PostgreSQL).
-- É aplicada automaticamente quando o servidor inicia (comandos idempotentes).

CREATE TABLE IF NOT EXISTS conteineres (
  numero              VARCHAR(11) PRIMARY KEY,           -- ISO 6346: 4 letras + 7 dígitos
  armador             VARCHAR(4)  NOT NULL DEFAULT 'AUTO', -- SCAC do armador
  descricao           TEXT,
  perigoso            BOOLEAN     NOT NULL DEFAULT FALSE,  -- carga perigosa (herdado do PortManager)
  classe_risco        VARCHAR(50),
  navio_mmsi          VARCHAR(15),
  navio_imo           VARCHAR(15),
  navio_nome          VARCHAR(255),
  porto_destino       VARCHAR(255),
  locode_destino      VARCHAR(5),
  eta_etracking       TIMESTAMPTZ,
  progresso           INTEGER,
  local_atual         TEXT,
  situacao            VARCHAR(30) NOT NULL DEFAULT 'monitorando', -- monitorando | entregue | arquivado
  ultimo_rastreio_em  TIMESTAMPTZ,
  rastreio_bruto      JSONB,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conteineres_mmsi ON conteineres (navio_mmsi);
CREATE INDEX IF NOT EXISTS idx_conteineres_imo ON conteineres (navio_imo);
CREATE INDEX IF NOT EXISTS idx_conteineres_situacao ON conteineres (situacao);

-- Histórico de eventos do eTracking (um registro por evento distinto).
CREATE TABLE IF NOT EXISTS eventos_conteiner (
  id            BIGSERIAL PRIMARY KEY,
  numero        VARCHAR(11) NOT NULL REFERENCES conteineres (numero) ON DELETE CASCADE,
  chave         TEXT        NOT NULL,          -- evento|locode|dataHora, evita duplicar
  evento        TEXT,
  porto         TEXT,
  locode        VARCHAR(10),
  data_hora     TIMESTAMPTZ,
  realizado     BOOLEAN     NOT NULL DEFAULT FALSE,
  navio         TEXT,
  fonte         VARCHAR(20) NOT NULL DEFAULT 'etracking',
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (numero, chave)
);

CREATE INDEX IF NOT EXISTS idx_eventos_numero ON eventos_conteiner (numero, data_hora);

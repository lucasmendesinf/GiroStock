-- Painel Master, fase 3: backups, configuracoes globais e aviso global.
-- Os arquivos de backup ficam em BACKUP_DIR (fora de qualquer pasta servida); aqui ficam so os registros.
CREATE TABLE backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  arquivo TEXT,
  tamanho_bytes BIGINT,
  sha256 TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('automatico', 'manual')),
  status TEXT NOT NULL DEFAULT 'gerando' CHECK (status IN ('gerando', 'concluido', 'falhou')),
  formato TEXT,
  erro TEXT,
  criado_por UUID, -- sem chave estrangeira de proposito: o registro dos backups precisa sobreviver a TRUNCATE/DROP de users numa restauracao
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em TIMESTAMPTZ,
  versao_schema TEXT
);
CREATE INDEX idx_backups_criado_em ON backups (criado_em DESC);

-- Chaves: vip_limite_padrao, cliente_risco_dias, cliente_inativo_dias, pedido_atrasado_min, backup_retencao_dias,
-- backup_hora, backup_automatico, manutencao. Chave ausente = valor padrao do codigo (services/config.js).
CREATE TABLE config_global (
  chave TEXT PRIMARY KEY,
  valor JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por UUID REFERENCES users(id)
);

-- Aviso para todos os usuarios: apenas um ativo por vez.
CREATE TABLE avisos_globais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mensagem TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  removido_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_aviso_global_ativo ON avisos_globais ((true)) WHERE ativo;

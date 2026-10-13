-- Verificacao em duas etapas (TOTP, RFC 6238) com aplicativo autenticador.
-- O segredo fica CIFRADO (AES-256-GCM, formato iv:tag:cifrado em base64); nunca em texto puro.
ALTER TABLE users ADD COLUMN totp_segredo_cript TEXT;
ALTER TABLE users ADD COLUMN totp_ativo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN totp_ativado_em TIMESTAMPTZ;
-- Ultimo passo (contador de 30 s) aceito: impede reutilizar o mesmo codigo.
ALTER TABLE users ADD COLUMN totp_ultimo_passo BIGINT;
-- A administracao exige 2FA deste usuario (o Master e sempre exigido pelo codigo, independente desta coluna).
ALTER TABLE users ADD COLUMN totp_exigido BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN totp_falhas INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_bloqueado_ate TIMESTAMPTZ;

-- Codigos de recuperacao (uso unico): so o hash e guardado.
CREATE TABLE user_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  codigo_hash TEXT NOT NULL,
  usado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_recovery_codes_user ON user_recovery_codes(user_id);

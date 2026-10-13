-- Painel Master, fase 1: empresas (status, plano, limites e recursos) e seguranca de usuarios.
-- Empresas ja existentes ficam no plano "completo", ativas e sem overrides: nada muda para quem ja usa o sistema.

CREATE TABLE planos (
  codigo TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  max_lojas INT NOT NULL,
  max_usuarios INT NOT NULL,
  max_pdvs INT NOT NULL,
  recursos JSONB NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO planos (codigo, nome, max_lojas, max_usuarios, max_pdvs, recursos) VALUES
  ('basico', 'Básico', 1, 3, 1, '{"pedidos": false, "clientes": false}'),
  ('completo', 'Completo', 3, 10, 4, '{"pedidos": true, "clientes": true}');

ALTER TABLE tenants ADD COLUMN documento TEXT;
ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'suspensa'));
ALTER TABLE tenants ADD COLUMN suspenso_motivo TEXT;
ALTER TABLE tenants ADD COLUMN suspenso_em TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN plano TEXT NOT NULL DEFAULT 'completo' REFERENCES planos(codigo);
-- Overrides opcionais por empresa: {"lojas": 5, "usuarios": 20, "pdvs": 6} e {"pedidos": true, "clientes": false}.
ALTER TABLE tenants ADD COLUMN limites JSONB;
ALTER TABLE tenants ADD COLUMN recursos JSONB;

ALTER TABLE users ADD COLUMN ultimo_login TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN falhas_login INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN ultima_falha_em TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN deve_trocar_senha BOOLEAN NOT NULL DEFAULT false;
-- Tokens emitidos antes desta data deixam de valer (encerrar sessoes).
ALTER TABLE users ADD COLUMN sessoes_validas_desde TIMESTAMPTZ;

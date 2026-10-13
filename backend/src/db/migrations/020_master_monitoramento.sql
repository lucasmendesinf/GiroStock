-- Monitoramento do painel Master (Fase 2): erros 5xx, ultimo acesso e listagem global da auditoria.
CREATE TABLE erros_sistema (
  id BIGSERIAL PRIMARY KEY,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  metodo TEXT NOT NULL,
  rota TEXT NOT NULL,
  status INT NOT NULL,
  mensagem TEXT NOT NULL DEFAULT '',
  tenant_id UUID,
  usuario_id UUID
);
CREATE INDEX idx_erros_sistema_criado_em ON erros_sistema (criado_em);

-- Atualizado no authRequired no maximo 1 vez por minuto por usuario ("usuarios online agora" = ultimos 5 min).
ALTER TABLE users ADD COLUMN ultimo_acesso TIMESTAMPTZ;

CREATE INDEX idx_audit_logs_criado_em ON audit_logs (criado_em DESC);

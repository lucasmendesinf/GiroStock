-- Painel Master, fase 4: "Entrar como suporte" (acesso temporario, auditado, do Master a uma empresa).
CREATE TABLE sessoes_suporte (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id UUID NOT NULL REFERENCES users(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  motivo TEXT NOT NULL,
  edicao BOOLEAN NOT NULL DEFAULT false,
  avisou_admins BOOLEAN NOT NULL DEFAULT false,
  iniciada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em TIMESTAMPTZ NOT NULL,
  encerrada_em TIMESTAMPTZ,
  encerrada_por TEXT CHECK (encerrada_por IN ('master', 'expirou', 'sistema')),
  senha_fp TEXT, -- impressao digital da senha do Master na hora do inicio: trocar a senha derruba a sessao
  ip TEXT
);
CREATE INDEX idx_sessoes_suporte_tenant ON sessoes_suporte (tenant_id, iniciada_em DESC);
CREATE INDEX idx_sessoes_suporte_master ON sessoes_suporte (master_id);

-- Avisos para os administradores da empresa. lido_por = ids dos usuarios que dispensaram.
CREATE TABLE avisos_empresa (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  tipo TEXT NOT NULL DEFAULT 'suporte',
  mensagem TEXT NOT NULL,
  sessao_suporte_id UUID REFERENCES sessoes_suporte(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  lido_por JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX idx_avisos_empresa_tenant ON avisos_empresa (tenant_id, criado_em DESC);

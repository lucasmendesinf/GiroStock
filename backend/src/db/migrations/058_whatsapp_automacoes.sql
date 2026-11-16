-- WhatsApp: campanhas automaticas (todo dia, no horario escolhido): cliente sumido ha X dias e aniversariante do dia,
-- com o cupom individual. Usam as mesmas regras das campanhas (consentimento, 7 dias entre campanhas, modelo aprovado).
CREATE TABLE whatsapp_automacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('sumido', 'aniversario')),
  ativo BOOLEAN NOT NULL DEFAULT false,
  dias INTEGER NOT NULL DEFAULT 30 CHECK (dias BETWEEN 7 AND 365),  -- sumido: dias sem pedir
  hora INTEGER NOT NULL DEFAULT 10 CHECK (hora BETWEEN 7 AND 21),     -- hora do envio (Sao Paulo)
  cupom_tipo TEXT NOT NULL DEFAULT 'percentual' CHECK (cupom_tipo IN ('percentual', 'valor', 'frete_gratis')),
  cupom_valor NUMERIC(12,2) NOT NULL DEFAULT 10,
  cupom_validade_dias INTEGER NOT NULL DEFAULT 7 CHECK (cupom_validade_dias BETWEEN 1 AND 90),
  cupom_pedido_minimo NUMERIC(12,2) NOT NULL DEFAULT 0,
  ultimo_dia DATE,                                                     -- ultimo dia em que rodou
  ultimo_total INTEGER,
  ultimo_motivo TEXT,                                                  -- por que nao enviou (sem ninguem apto, WhatsApp desconectado...)
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tipo)
);
ALTER TABLE whatsapp_campanhas ADD COLUMN automacao_id UUID REFERENCES whatsapp_automacoes(id) ON DELETE SET NULL;
CREATE INDEX idx_whatsapp_campanhas_automacao ON whatsapp_campanhas(automacao_id) WHERE automacao_id IS NOT NULL;

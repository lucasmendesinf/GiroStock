-- Casa de shows e eventos, Fase 2: estoque do evento.
-- Carga: transferencias do deposito para o setor, ligadas ao evento (pode haver reforco durante o evento).
-- Perdas: saidas classificadas (quebra, vencido, cortesia...), ligadas ao evento.
-- Fechamento: contagem do que sobrou no setor; a diferenca para o saldo do sistema vira perda (ou sobra) e o que sobrou
-- pode voltar ao deposito. Fica registrado produto a produto em evento_contagens (base do relatorio de quebra).
ALTER TABLE stock_movements ADD COLUMN evento_id UUID REFERENCES eventos(id);
ALTER TABLE stock_movements ADD COLUMN perda_tipo TEXT
  CHECK (perda_tipo IS NULL OR perda_tipo IN ('quebra', 'vencido', 'cortesia', 'consumo_interno', 'furto', 'diferenca_contagem', 'outro'));
CREATE INDEX idx_stock_movements_evento ON stock_movements(evento_id) WHERE evento_id IS NOT NULL;

ALTER TABLE eventos ADD COLUMN estoque_fechado_em TIMESTAMPTZ;
ALTER TABLE eventos ADD COLUMN estoque_fechado_por UUID REFERENCES users(id);

CREATE TABLE evento_contagens (
  evento_id UUID NOT NULL REFERENCES eventos(id),
  product_id UUID NOT NULL REFERENCES products(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  saldo_sistema NUMERIC(14,3) NOT NULL,   -- saldo do setor na hora da contagem
  contado NUMERIC(14,3) NOT NULL CHECK (contado >= 0),
  diferenca NUMERIC(14,3) NOT NULL,       -- contado - saldo_sistema (negativa = faltou)
  devolvido NUMERIC(14,3) NOT NULL DEFAULT 0,
  custo_unitario NUMERIC(12,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (evento_id, product_id)
);

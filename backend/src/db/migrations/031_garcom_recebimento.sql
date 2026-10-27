-- Garcom, Fase 2: receber na hora (no app), pagamento dividido (varias formas na mesma venda), taxa de servico e prestacao de contas
-- do dinheiro que fica com o garcom.

-- Configuracao por loja. terminal_comandas_id fica SEM chave estrangeira de proposito: locations e terminals ja se referenciam
-- (terminals.location_id) e o ciclo quebraria backup e copia do modo teste; o codigo valida o terminal.
ALTER TABLE locations ADD COLUMN taxa_servico_pct NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (taxa_servico_pct >= 0 AND taxa_servico_pct <= 100);
ALTER TABLE locations ADD COLUMN garcom_recebe BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE locations ADD COLUMN garcom_formas JSONB NOT NULL DEFAULT '{"pix": true, "cartao": true, "dinheiro": true}'::jsonb;
ALTER TABLE locations ADD COLUMN terminal_comandas_id UUID;

-- Taxa de servico da venda: compoe o total (como a taxa de entrega).
ALTER TABLE sales ADD COLUMN taxa_servico NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (taxa_servico >= 0);

-- Recebimentos feitos pelo garcom no app. Um recebimento quita rodadas INTEIRAS (comanda_pagamento_rodadas).
-- provider/provider_ref: ponto de extensao para maquininha/Pix com confirmacao automatica (hoje sempre 'manual').
CREATE TABLE comanda_pagamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  comanda_id UUID NOT NULL REFERENCES comandas(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  valor_produtos NUMERIC(12,2) NOT NULL CHECK (valor_produtos > 0),
  taxa_servico NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (taxa_servico >= 0),
  forma payment_method NOT NULL,
  valor_recebido NUMERIC(12,2),
  troco NUMERIC(12,2),
  recebido_por UUID NOT NULL REFERENCES users(id),
  recebido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'confirmado' CHECK (status IN ('confirmado', 'estornado')),
  estornado_por UUID REFERENCES users(id),
  estornado_em TIMESTAMPTZ,
  motivo_estorno TEXT,
  prestado_em TIMESTAMPTZ,
  prestado_por UUID REFERENCES users(id),
  cash_session_id UUID REFERENCES cash_sessions(id),
  cash_movement_id UUID REFERENCES cash_movements(id),
  diferenca_prestacao NUMERIC(12,2),
  provider TEXT NOT NULL DEFAULT 'manual',
  provider_ref TEXT
);
CREATE INDEX idx_comanda_pagamentos_comanda ON comanda_pagamentos(comanda_id);
CREATE INDEX idx_comanda_pagamentos_garcom ON comanda_pagamentos(tenant_id, recebido_por, prestado_em);

-- Uma rodada so pode estar em UM recebimento (UNIQUE). Estornar o recebimento apaga o vinculo e libera a rodada.
CREATE TABLE comanda_pagamento_rodadas (
  pagamento_id UUID NOT NULL REFERENCES comanda_pagamentos(id) ON DELETE CASCADE,
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
  PRIMARY KEY (pagamento_id, order_id)
);

-- Formas de pagamento da venda (uma ou varias). valor = quanto cada forma pagou (soma = total da venda, com taxas).
-- entra_no_caixa: dinheiro recebido pelo garcom NAO entra no caixa da venda; entra pela prestacao de contas (suprimento).
CREATE TABLE sale_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  sale_id UUID NOT NULL REFERENCES sales(id),
  forma payment_method NOT NULL,
  valor NUMERIC(12,2) NOT NULL CHECK (valor >= 0),
  valor_recebido NUMERIC(12,2),
  troco NUMERIC(12,2),
  comanda_pagamento_id UUID REFERENCES comanda_pagamentos(id),
  recebido_por UUID REFERENCES users(id),
  entra_no_caixa BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id);
CREATE INDEX idx_sale_payments_tenant_forma ON sale_payments(tenant_id, forma);

-- Pagamentos de TODAS as vendas, antigas e novas: vendas sem linhas em sale_payments (anteriores a esta migration) valem como
-- uma forma so (sales.forma_pagamento) com o total. Relatorios, caixa e financeiro leem esta visao.
CREATE VIEW v_sale_pagamentos AS
  SELECT sp.tenant_id, sp.sale_id, sp.forma, sp.valor, sp.entra_no_caixa FROM sale_payments sp
  UNION ALL
  SELECT s.tenant_id, s.id, s.forma_pagamento, s.total, true FROM sales s
   WHERE NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id);

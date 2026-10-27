-- Garcom, Fase 3: comissoes (regras, lancamentos por item, acertos) e o ajuste do cadastro (produto fora da comissao, % por garcom).
--
-- Dinheiro: todos os valores sao calculados em CENTAVOS (inteiros) e gravados em NUMERIC(12,2). Cada lancamento e imutavel; estorno
-- de lancamento pendente muda o status para 'estornada'; estorno de lancamento ja pago (em acerto) gera um lancamento NEGATIVO pendente
-- (origem 'ajuste', estorno_de = o original) que desconta no proximo acerto. Nada e apagado.

ALTER TABLE products ADD COLUMN fora_da_comissao BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN comissao_pct NUMERIC(5,2) CHECK (comissao_pct IS NULL OR (comissao_pct >= 0 AND comissao_pct <= 100));

-- Regras de comissao da empresa (uma por empresa; location_id fica para regras por loja no futuro).
CREATE TABLE comissao_regras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  location_id UUID REFERENCES locations(id),
  pct_padrao NUMERIC(5,2) NOT NULL DEFAULT 5 CHECK (pct_padrao >= 0 AND pct_padrao <= 100),
  por_categoria JSONB NOT NULL DEFAULT '{}'::jsonb,
  taxa_servico_repasse_pct NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK (taxa_servico_repasse_pct >= 0 AND taxa_servico_repasse_pct <= 100),
  base TEXT NOT NULL DEFAULT 'liquida' CHECK (base IN ('liquida', 'bruta')),
  meta_valor NUMERIC(12,2) CHECK (meta_valor IS NULL OR meta_valor >= 0),
  meta_bonus_pct NUMERIC(5,2) CHECK (meta_bonus_pct IS NULL OR (meta_bonus_pct >= 0 AND meta_bonus_pct <= 100)),
  meta_periodo TEXT NOT NULL DEFAULT 'noite' CHECK (meta_periodo IN ('noite', 'semana', 'mes')),
  estorno_desconta BOOLEAN NOT NULL DEFAULT true,
  corte_hora SMALLINT NOT NULL DEFAULT 6 CHECK (corte_hora >= 0 AND corte_hora <= 23), -- a "noite" comercial vai do corte ate o corte do dia seguinte
  atualizado_por UUID REFERENCES users(id),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_comissao_regras_empresa ON comissao_regras(tenant_id) WHERE location_id IS NULL;

-- Acerto (pagamento das comissoes de um periodo). titulo_id: a conta a pagar lancada no Financeiro (opcional).
CREATE TABLE comissao_acertos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  numero INTEGER NOT NULL,
  periodo_inicio DATE NOT NULL,
  periodo_fim DATE NOT NULL,
  total NUMERIC(12,2) NOT NULL CHECK (total > 0),
  forma_pagamento TEXT,
  pago_em DATE NOT NULL,
  pago_por UUID REFERENCES users(id),
  titulo_id UUID REFERENCES fin_titulos(id),
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, numero)
);

CREATE TABLE comissao_acerto_itens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  acerto_id UUID NOT NULL REFERENCES comissao_acertos(id) ON DELETE CASCADE,
  garcom_id UUID NOT NULL REFERENCES users(id),
  valor NUMERIC(12,2) NOT NULL,
  lancamentos INTEGER NOT NULL DEFAULT 0,
  UNIQUE (acerto_id, garcom_id)
);

CREATE TABLE comissoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  garcom_id UUID NOT NULL REFERENCES users(id),
  comanda_id UUID REFERENCES comandas(id),
  sale_id UUID REFERENCES sales(id),
  comanda_pagamento_id UUID REFERENCES comanda_pagamentos(id),
  order_item_id UUID REFERENCES order_items(id),
  origem TEXT NOT NULL CHECK (origem IN ('recebimento', 'fechamento', 'ajuste', 'bonus')),
  base_valor NUMERIC(12,2) NOT NULL DEFAULT 0,
  pct_aplicado NUMERIC(5,2),
  valor_produtos NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_servico NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'paga', 'estornada')),
  acerto_id UUID REFERENCES comissao_acertos(id),
  periodo_ref TEXT,                       -- bonus: o periodo (noite/semana/mes) a que se refere; um bonus por garcom e periodo
  estorno_de UUID REFERENCES comissoes(id),
  estornado_em TIMESTAMPTZ,
  motivo TEXT,
  regra_snapshot JSONB,
  criado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_comissoes_garcom_status ON comissoes(tenant_id, garcom_id, status);
CREATE INDEX idx_comissoes_sale ON comissoes(sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX idx_comissoes_comanda ON comissoes(comanda_id) WHERE comanda_id IS NOT NULL;
CREATE INDEX idx_comissoes_pagamento ON comissoes(comanda_pagamento_id) WHERE comanda_pagamento_id IS NOT NULL;
-- Idempotencia: um item rende comissao UMA vez (recebimento ou fechamento) enquanto o lancamento nao for estornado.
CREATE UNIQUE INDEX uq_comissao_item ON comissoes(order_item_id) WHERE origem IN ('recebimento', 'fechamento') AND estornado_em IS NULL;
-- Bonus por meta: uma vez por garcom e periodo.
CREATE UNIQUE INDEX uq_comissao_bonus ON comissoes(tenant_id, garcom_id, periodo_ref) WHERE origem = 'bonus' AND estornado_em IS NULL;

-- Categoria financeira "Comissoes" (despesa) para as empresas que ja usam o Financeiro; as novas recebem pelo padrao do sistema.
INSERT INTO fin_categorias (tenant_id, tipo, nome, entra_no_resultado)
SELECT DISTINCT tenant_id, 'despesa', 'Comissões', true FROM fin_categorias
ON CONFLICT DO NOTHING;

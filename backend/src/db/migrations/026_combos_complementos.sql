-- Combos e complementos (adicionais) + disponibilidade automatica no iFood.
--
-- Complementos: grupos (ex.: "Adicionais", minimo 0 / maximo 3; "Escolha a bebida", minimo 1 / maximo 1) com opcoes.
-- Cada opcao pode baixar um insumo (Bacon extra = 30 g de bacon) ou um produto (Coca lata no combo), e tem preco
-- (0 = sem acrescimo). O produto escolhe quais grupos oferece.
-- Combo: produto sem estoque proprio, feito de outros produtos (X-Burguer + Batata + Refri): a venda baixa os
-- componentes (estoque ou insumos da ficha de cada um). O cancelamento estorna pelas mesmas tabelas da venda.

CREATE TABLE grupos_complementos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL,
  minimo INT NOT NULL DEFAULT 0 CHECK (minimo >= 0),
  maximo INT NOT NULL DEFAULT 1 CHECK (maximo >= 1),
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (maximo >= minimo)
);
CREATE UNIQUE INDEX uq_grupo_complemento_nome ON grupos_complementos(tenant_id, lower(nome));

CREATE TABLE complementos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  grupo_id UUID NOT NULL REFERENCES grupos_complementos(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  preco NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (preco >= 0),
  -- Codigo PDV do complemento no iFood (externalCode da opcao): liga o adicional do pedido do iFood e permite pausar.
  codigo TEXT,
  ingredient_id UUID REFERENCES ingredients(id),
  quantidade_insumo NUMERIC(12,3),
  product_id UUID REFERENCES products(id),
  quantidade_produto NUMERIC(12,3),
  ordem INT NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- No maximo uma origem de baixa (insumo OU produto); nenhuma = so muda o preco/observacao (ex.: "ao ponto").
  CHECK (ingredient_id IS NULL OR product_id IS NULL),
  CHECK (ingredient_id IS NULL OR quantidade_insumo > 0),
  CHECK (product_id IS NULL OR quantidade_produto > 0)
);
CREATE INDEX idx_complementos_grupo ON complementos(grupo_id, ordem);
CREATE UNIQUE INDEX uq_complemento_codigo ON complementos(tenant_id, codigo) WHERE codigo IS NOT NULL;

CREATE TABLE produto_grupos (
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  grupo_id UUID NOT NULL REFERENCES grupos_complementos(id) ON DELETE CASCADE,
  ordem INT NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, grupo_id)
);
CREATE INDEX idx_produto_grupos_grupo ON produto_grupos(grupo_id);

CREATE TABLE combo_itens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  combo_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  quantidade NUMERIC(12,3) NOT NULL CHECK (quantidade > 0),
  CHECK (combo_id <> product_id)
);
CREATE UNIQUE INDEX uq_combo_item ON combo_itens(combo_id, product_id);
CREATE INDEX idx_combo_itens_produto ON combo_itens(product_id);

-- Complementos escolhidos em cada item: [{ "id", "nome", "quantidade" (por unidade do item), "preco" }].
ALTER TABLE order_items ADD COLUMN complementos JSONB;
ALTER TABLE sale_items ADD COLUMN complementos JSONB;

-- iFood: produto que a loja vende no iFood (a disponibilidade e mantida pelo GiroStock) e o codigo PDV usado no
-- cardapio do iFood (vazio = o codigo interno, ex.: PRD-0002).
ALTER TABLE products ADD COLUMN vende_ifood BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN codigo_ifood TEXT;
CREATE UNIQUE INDEX uq_produto_codigo_ifood ON products(tenant_id, codigo_ifood) WHERE codigo_ifood IS NOT NULL;

-- Ultimo status enviado ao iFood por conexao (so as mudancas sao enviadas).
CREATE TABLE ifood_disponibilidade (
  integracao_id UUID NOT NULL REFERENCES integracoes_delivery(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('item', 'complemento')),
  codigo TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'UNAVAILABLE')),
  motivo TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (integracao_id, tipo, codigo)
);

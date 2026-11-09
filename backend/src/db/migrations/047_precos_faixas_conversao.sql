-- Preco por loja, desconto por quantidade (pack/atacado) e produto que vira insumo na transferencia.
-- O custo continua UM so por produto (products.preco_custo); so o preco de venda varia por loja.

-- Preco de venda de um produto em uma loja. Sem linha = herda products.preco_venda e vende.
CREATE TABLE produto_precos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id),
  preco_venda NUMERIC(12,2) CHECK (preco_venda IS NULL OR preco_venda > 0),   -- NULL = herda o preco padrao
  vende BOOLEAN NOT NULL DEFAULT true,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, location_id)
);
CREATE INDEX idx_produto_precos_tenant ON produto_precos(tenant_id, location_id);

-- Faixas de desconto por quantidade (mesmo produto, sem mistura). location_id NULL = vale para as lojas sem faixas proprias.
CREATE TABLE produto_faixas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id),
  rotulo TEXT NOT NULL DEFAULT '',
  quantidade_minima INTEGER NOT NULL CHECK (quantidade_minima >= 2),
  preco_unitario NUMERIC(12,2) NOT NULL CHECK (preco_unitario > 0),          -- ja em reais por unidade
  modo_cadastro TEXT NOT NULL DEFAULT 'unitario' CHECK (modo_cadastro IN ('unitario', 'kit', 'percentual')),
  valor_cadastro NUMERIC(14,4),                                              -- como o usuario informou (para reabrir a tela igual)
  automatica BOOLEAN NOT NULL DEFAULT true,
  ean_pack TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_produto_faixas_produto ON produto_faixas(tenant_id, product_id);
CREATE UNIQUE INDEX uq_produto_faixas_ean_pack ON produto_faixas(tenant_id, ean_pack) WHERE ean_pack IS NOT NULL AND ativo;

-- O que foi cobrado x o preco de tabela da loja (relatorio de desconto por quantidade). Nulos nas vendas sem faixa.
ALTER TABLE sale_items ADD COLUMN preco_tabela NUMERIC(12,2);
ALTER TABLE sale_items ADD COLUMN faixa_rotulo TEXT;
ALTER TABLE order_items ADD COLUMN preco_tabela NUMERIC(12,2);
ALTER TABLE order_items ADD COLUMN faixa_rotulo TEXT;

-- Produto que vira insumo na transferencia: 1 <unidade do produto> = <fator> <unidade do insumo>.
CREATE TABLE produto_conversoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id),
  fator NUMERIC(14,4) NOT NULL CHECK (fator > 0),
  modo TEXT NOT NULL DEFAULT 'perguntar' CHECK (modo IN ('perguntar', 'sempre')),
  ativo BOOLEAN NOT NULL DEFAULT true,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Lojas em que o produto vira insumo (o destino da transferencia precisa estar aqui).
CREATE TABLE produto_conversao_lojas (
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  PRIMARY KEY (product_id, location_id)
);

-- Transferencia com conversao: o movimento do produto guarda o insumo e a quantidade que entrou no destino
-- (o lado do insumo vai para a auditoria, com o id deste movimento).
ALTER TABLE stock_movements ADD COLUMN conversao_ingredient_id UUID REFERENCES ingredients(id);
ALTER TABLE stock_movements ADD COLUMN conversao_quantidade NUMERIC(14,3);

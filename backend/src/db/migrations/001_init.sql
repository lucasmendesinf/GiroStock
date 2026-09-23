-- GiroStock — Etapa 2: Estrutura Principal + PDV
-- Schema multi-tenant. Toda tabela relevante carrega tenant_id.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_locations_tenant ON locations(tenant_id);

CREATE TABLE terminals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  nome TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_terminals_tenant_location ON terminals(tenant_id, location_id);

CREATE TYPE user_role AS ENUM ('Administrador','Gerente','Caixa/Operador','Estoque','Lanchonete/Cozinha','Financeiro');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL,
  email CITEXT,
  senha_hash TEXT NOT NULL,
  perfil user_role NOT NULL,
  location_id UUID REFERENCES locations(id),
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE EXTENSION IF NOT EXISTS citext;
CREATE UNIQUE INDEX uq_users_tenant_email ON users(tenant_id, email);
CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL,
  documento VARCHAR(14) NOT NULL,
  telefone TEXT,
  email TEXT,
  categoria TEXT NOT NULL CHECK (categoria IN ('Bebidas','Cigarros e Tabacaria','Alimentos e Insumos','Embalagens','Outros')),
  prazo_medio_dias INTEGER,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_documento_formato CHECK (documento ~ '^[0-9]{11}$' OR documento ~ '^[0-9]{14}$')
);
CREATE UNIQUE INDEX uq_suppliers_tenant_documento ON suppliers(tenant_id, documento);
CREATE INDEX idx_suppliers_tenant ON suppliers(tenant_id);

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL
);
CREATE INDEX idx_categories_tenant ON categories(tenant_id);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  codigo_interno TEXT NOT NULL,
  nome TEXT NOT NULL CHECK (char_length(nome) >= 3),
  categoria_id UUID REFERENCES categories(id),
  supplier_id UUID REFERENCES suppliers(id),
  barcode VARCHAR(14) NOT NULL,
  unidade TEXT NOT NULL CHECK (unidade IN ('UN','KG','L','CX')),
  preco_custo NUMERIC(12,2) NOT NULL CHECK (preco_custo > 0),
  preco_venda NUMERIC(12,2) NOT NULL CHECK (preco_venda > 0),
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_barcode_formato CHECK (barcode ~ '^[0-9]{8,14}$'),
  CONSTRAINT chk_venda_maior_custo CHECK (preco_venda > preco_custo)
);
CREATE UNIQUE INDEX uq_products_tenant_barcode ON products(tenant_id, barcode);
CREATE UNIQUE INDEX uq_products_tenant_codigo ON products(tenant_id, codigo_interno);
CREATE INDEX idx_products_tenant ON products(tenant_id);

CREATE TABLE stock_balances (
  product_id UUID NOT NULL REFERENCES products(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  saldo NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (saldo >= 0),
  PRIMARY KEY (product_id, location_id)
);
CREATE INDEX idx_stock_balances_tenant ON stock_balances(tenant_id);

CREATE TYPE stock_move_type AS ENUM ('entrada','saida','transferencia');

CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id),
  tipo stock_move_type NOT NULL,
  quantidade NUMERIC(14,3) NOT NULL CHECK (quantidade > 0),
  location_origem_id UUID REFERENCES locations(id),
  location_destino_id UUID REFERENCES locations(id),
  motivo TEXT NOT NULL,
  usuario_id UUID NOT NULL REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_movements_tenant ON stock_movements(tenant_id, product_id);

CREATE TABLE ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL,
  unidade TEXT NOT NULL,
  estoque_atual NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (estoque_atual >= 0),
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ingredients_tenant ON ingredients(tenant_id);

CREATE TABLE product_ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id),
  ingredient_id UUID NOT NULL REFERENCES ingredients(id),
  quantidade_por_unidade NUMERIC(14,3) NOT NULL CHECK (quantidade_por_unidade > 0)
);
CREATE UNIQUE INDEX uq_product_ingredient ON product_ingredients(product_id, ingredient_id);
CREATE INDEX idx_product_ingredients_tenant ON product_ingredients(tenant_id, product_id);

CREATE TABLE cash_registers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  terminal_id UUID NOT NULL REFERENCES terminals(id)
);
CREATE INDEX idx_cash_registers_tenant ON cash_registers(tenant_id);

CREATE TABLE cash_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  cash_register_id UUID NOT NULL REFERENCES cash_registers(id),
  usuario_abertura_id UUID NOT NULL REFERENCES users(id),
  valor_inicial NUMERIC(12,2) NOT NULL CHECK (valor_inicial >= 0),
  aberto_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  fechado_em TIMESTAMPTZ,
  valor_informado_fechamento NUMERIC(12,2),
  valor_esperado_fechamento NUMERIC(12,2),
  diferenca NUMERIC(12,2)
);
CREATE INDEX idx_cash_sessions_tenant ON cash_sessions(tenant_id, cash_register_id);
-- Apenas uma sessão aberta por caixa
CREATE UNIQUE INDEX uq_cash_sessions_open ON cash_sessions(cash_register_id) WHERE fechado_em IS NULL;

CREATE TYPE cash_move_type AS ENUM ('sangria','suprimento');

CREATE TABLE cash_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  cash_session_id UUID NOT NULL REFERENCES cash_sessions(id),
  tipo cash_move_type NOT NULL,
  valor NUMERIC(12,2) NOT NULL CHECK (valor > 0),
  motivo TEXT NOT NULL,
  usuario_id UUID NOT NULL REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cash_movements_tenant ON cash_movements(tenant_id, cash_session_id);

CREATE TYPE payment_method AS ENUM ('pix','cartao_credito','cartao_debito','dinheiro');
CREATE TYPE sale_status AS ENUM ('concluida','cancelada');

CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  terminal_id UUID NOT NULL REFERENCES terminals(id),
  cash_session_id UUID NOT NULL REFERENCES cash_sessions(id),
  operador_id UUID NOT NULL REFERENCES users(id),
  forma_pagamento payment_method NOT NULL,
  valor_recebido NUMERIC(12,2),
  troco NUMERIC(12,2),
  total NUMERIC(12,2) NOT NULL CHECK (total > 0),
  status sale_status NOT NULL DEFAULT 'concluida',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sales_tenant ON sales(tenant_id, location_id, criado_em);
CREATE INDEX idx_sales_tenant_operador ON sales(tenant_id, operador_id);
CREATE INDEX idx_sales_tenant_forma ON sales(tenant_id, forma_pagamento);

CREATE TABLE sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  sale_id UUID NOT NULL REFERENCES sales(id),
  product_id UUID NOT NULL REFERENCES products(id),
  quantidade NUMERIC(14,3) NOT NULL CHECK (quantidade > 0),
  preco_unitario NUMERIC(12,2) NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL
);
CREATE INDEX idx_sale_items_tenant_sale ON sale_items(tenant_id, sale_id);

CREATE TABLE ingredient_consumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  sale_item_id UUID NOT NULL REFERENCES sale_items(id),
  ingredient_id UUID NOT NULL REFERENCES ingredients(id),
  quantidade_consumida NUMERIC(14,3) NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ingredient_consumptions_tenant ON ingredient_consumptions(tenant_id, sale_item_id);

-- Auditoria: toda alteração relevante de estoque, preço, caixa ou permissão
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  usuario_id UUID REFERENCES users(id),
  acao TEXT NOT NULL,
  recurso TEXT NOT NULL,
  recurso_id UUID,
  detalhes JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_logs_tenant ON audit_logs(tenant_id, recurso, criado_em);

-- Pedidos (lanchonete): o cliente pede, o lanche e preparado e so depois e retirado/entregue.
-- O estoque e reservado ao criar o pedido (calculado sobre os pedidos em aberto) e vira baixa definitiva
-- quando o pedido e finalizado (gera a venda). Cancelar libera a reserva.
ALTER TABLE locations ADD COLUMN usa_pedidos BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sales ADD COLUMN taxa_entrega NUMERIC(12,2) NOT NULL DEFAULT 0;

CREATE TABLE couriers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_couriers_tenant ON couriers(tenant_id);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  numero INTEGER NOT NULL,
  origem TEXT NOT NULL CHECK (origem IN ('balcao', 'telefone', 'whatsapp', 'ifood', '99food')),
  origem_externa_id TEXT,
  cliente_nome TEXT NOT NULL DEFAULT '',
  cliente_telefone TEXT NOT NULL DEFAULT '',
  tipo TEXT NOT NULL CHECK (tipo IN ('retirada', 'entrega')),
  endereco TEXT NOT NULL DEFAULT '',
  taxa_entrega NUMERIC(12,2) NOT NULL DEFAULT 0,
  observacao TEXT NOT NULL DEFAULT '',
  forma_pagamento_prevista TEXT,
  pago BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'novo' CHECK (status IN ('novo', 'em_preparo', 'pronto', 'saiu_entrega', 'finalizado', 'cancelado')),
  entregador_id UUID REFERENCES couriers(id),
  sale_id UUID REFERENCES sales(id),
  criado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalizado_em TIMESTAMPTZ,
  cancelado_em TIMESTAMPTZ,
  motivo_cancelamento TEXT
);
CREATE INDEX idx_orders_tenant_loja_status ON orders(tenant_id, location_id, status);
CREATE INDEX idx_orders_criado ON orders(tenant_id, criado_em);

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  quantidade NUMERIC(12,3) NOT NULL CHECK (quantidade > 0),
  preco_unitario NUMERIC(12,2) NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL,
  observacao TEXT
);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_product ON order_items(product_id);

CREATE TABLE order_status_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  de TEXT,
  para TEXT NOT NULL,
  usuario_id UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_log_order ON order_status_log(order_id, criado_em);

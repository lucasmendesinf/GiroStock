-- Clientes: base criada a partir dos pedidos (o telefone, so digitos, e a chave unica por empresa).
-- Os agregados (pedidos, total gasto, ultimo pedido, favorito) e os segmentos sao calculados por consulta.
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL,
  telefone TEXT,
  aniversario TEXT,
  observacao TEXT NOT NULL DEFAULT '',
  aceita_mensagens BOOLEAN NOT NULL DEFAULT false,
  consentimento_em TIMESTAMPTZ,
  consentimento_origem TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_customers_telefone ON customers(tenant_id, telefone) WHERE telefone IS NOT NULL AND telefone <> '';
CREATE INDEX idx_customers_tenant ON customers(tenant_id);

CREATE TABLE customer_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rotulo TEXT NOT NULL DEFAULT 'Casa',
  endereco TEXT NOT NULL,
  bairro TEXT NOT NULL DEFAULT '',
  padrao BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_customer_addresses_customer ON customer_addresses(customer_id);

ALTER TABLE orders ADD COLUMN customer_id UUID REFERENCES customers(id);
CREATE INDEX idx_orders_customer ON orders(customer_id);

CREATE TABLE message_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  customer_id UUID REFERENCES customers(id),
  segmento TEXT,
  modelo TEXT,
  texto TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'fila',
  enviado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_log_customer ON message_log(tenant_id, customer_id, criado_em);

-- Valor total gasto a partir do qual o cliente e VIP (padrao R$ 400).
ALTER TABLE tenants ADD COLUMN clientes_vip_limite NUMERIC(12,2) NOT NULL DEFAULT 400;

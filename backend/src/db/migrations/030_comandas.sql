-- Garcom, Fase 1: comandas de mesa e de pista, com varias rodadas de pedido. Cada rodada e um pedido (orders) ligado a comanda:
-- assim cozinha/bar, reserva de estoque e impressao ja existentes funcionam. A venda unica nasce no fechamento da comanda, no caixa.
CREATE TABLE comandas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  numero INTEGER NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('mesa', 'pista')),
  identificador TEXT NOT NULL,
  cliente_nome TEXT NOT NULL DEFAULT '',
  modo_pagamento TEXT NOT NULL DEFAULT 'conta' CHECK (modo_pagamento IN ('conta', 'hora')),
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'fechamento_solicitado', 'paga', 'cancelada')),
  aberta_por UUID REFERENCES users(id),
  aberta_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  fechamento_solicitado_em TIMESTAMPTZ,
  fechada_em TIMESTAMPTZ,
  fechada_por UUID REFERENCES users(id),
  sale_id UUID REFERENCES sales(id),
  observacao TEXT NOT NULL DEFAULT '',
  motivo_cancelamento TEXT,
  UNIQUE (tenant_id, location_id, numero)
);
CREATE INDEX idx_comandas_tenant_loja_status ON comandas(tenant_id, location_id, status);
CREATE INDEX idx_comandas_aberta_por ON comandas(aberta_por, status);
-- Uma comanda aberta por mesa (ou por pulseira) na loja.
CREATE UNIQUE INDEX uq_comanda_identificador_aberta ON comandas(tenant_id, location_id, lower(identificador)) WHERE status IN ('aberta', 'fechamento_solicitado');

-- Garcons que atendem a comanda (quem abriu, quem entrou na mesa, quem recebeu por transferencia): so eles a veem.
CREATE TABLE comanda_garcons (
  comanda_id UUID NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  desde TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (comanda_id, user_id)
);
CREATE INDEX idx_comanda_garcons_user ON comanda_garcons(user_id);

-- Rodada = pedido de comanda: tipo mesa/pista, status 'entregue' (servido; continua reservando estoque ate o fechamento).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'c'
            AND (pg_get_constraintdef(oid) ILIKE '%retirada%' OR pg_get_constraintdef(oid) ILIKE '%em_preparo%')
  LOOP
    EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE orders ADD CONSTRAINT orders_tipo_check CHECK (tipo IN ('retirada', 'entrega', 'mesa', 'pista'));
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('novo', 'em_preparo', 'pronto', 'saiu_entrega', 'entregue', 'finalizado', 'cancelado'));
ALTER TABLE orders ADD COLUMN comanda_id UUID REFERENCES comandas(id);
ALTER TABLE orders ADD COLUMN rodada INTEGER;
ALTER TABLE orders ADD COLUMN client_id UUID;
CREATE INDEX idx_orders_comanda ON orders(comanda_id) WHERE comanda_id IS NOT NULL;
-- Reenvio da mesma rodada (sinal ruim no celular) nao duplica.
CREATE UNIQUE INDEX uq_orders_comanda_client ON orders(comanda_id, client_id) WHERE client_id IS NOT NULL;

-- Garcom que lancou cada item (base da comissao): no pedido/rodada e na venda gerada no fechamento.
ALTER TABLE order_items ADD COLUMN garcom_id UUID REFERENCES users(id);
ALTER TABLE sale_items ADD COLUMN garcom_id UUID REFERENCES users(id);
-- Sem chave estrangeira de proposito: comandas.sale_id ja aponta para sales, e as duas juntas formariam um ciclo (quebra backup e copia do modo teste).
ALTER TABLE sales ADD COLUMN comanda_id UUID;
CREATE INDEX idx_order_items_garcom ON order_items(garcom_id) WHERE garcom_id IS NOT NULL;
CREATE INDEX idx_sale_items_garcom ON sale_items(garcom_id) WHERE garcom_id IS NOT NULL;

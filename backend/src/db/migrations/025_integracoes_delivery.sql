-- Integracao com plataformas de delivery (iFood agora; 99Food depois), modulo "iFood e 99Food" (delivery_apps).
-- Cada loja conecta a sua conta da plataforma (app distribuido: a loja autoriza no Portal do Parceiro).
-- Os pedidos chegam por polling, ficam guardados como vieram (pedidos_externos) e viram pedidos do GiroStock
-- quando todos os itens estao vinculados a produtos.

-- Pago na plataforma (cartao/pix online no app): nao entra no dinheiro do caixa.
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'online';

-- Pedido vindo de plataforma: numero curto da plataforma (ex.: iFood "displayId") e desconto bancado pela loja.
ALTER TABLE orders ADD COLUMN codigo_externo TEXT;
ALTER TABLE orders ADD COLUMN desconto NUMERIC(12,2) NOT NULL DEFAULT 0;
CREATE INDEX idx_orders_origem_externa ON orders(tenant_id, origem, origem_externa_id) WHERE origem_externa_id IS NOT NULL;

CREATE TABLE integracoes_delivery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  plataforma TEXT NOT NULL CHECK (plataforma IN ('ifood', '99food')),
  -- aguardando_codigo: codigo de vinculo gerado, esperando a loja autorizar no portal
  -- escolher_loja: autorizado, mas a conta tem mais de uma loja na plataforma
  -- conectado | reautorizar (token recusado: conectar de novo) | desconectado
  status TEXT NOT NULL DEFAULT 'aguardando_codigo' CHECK (status IN ('aguardando_codigo', 'escolher_loja', 'conectado', 'reautorizar', 'desconectado')),
  merchant_id TEXT,
  merchant_nome TEXT,
  aceite_automatico BOOLEAN NOT NULL DEFAULT false,
  codigo_vinculo TEXT,
  codigo_vinculo_expira_em TIMESTAMPTZ,
  verificador_token_cript TEXT,
  access_token_cript TEXT,
  refresh_token_cript TEXT,
  token_expira_em TIMESTAMPTZ,
  lojas_disponiveis JSONB,
  ultimo_polling_em TIMESTAMPTZ,
  ultimo_erro TEXT,
  ultimo_erro_em TIMESTAMPTZ,
  criado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Uma conexao por loja e plataforma; a mesma loja da plataforma nao pode estar ligada a duas lojas.
CREATE UNIQUE INDEX uq_integracao_loja ON integracoes_delivery(location_id, plataforma);
CREATE UNIQUE INDEX uq_integracao_merchant ON integracoes_delivery(plataforma, merchant_id) WHERE merchant_id IS NOT NULL AND status <> 'desconectado';
CREATE INDEX idx_integracoes_tenant ON integracoes_delivery(tenant_id);

-- Vinculo item da plataforma -> produto do GiroStock (lembrado para os proximos pedidos).
CREATE TABLE integracao_itens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  plataforma TEXT NOT NULL,
  chave TEXT NOT NULL,
  nome_externo TEXT NOT NULL DEFAULT '',
  product_id UUID NOT NULL REFERENCES products(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_integracao_item ON integracao_itens(tenant_id, plataforma, chave);

-- Pedido como veio da plataforma (payload bruto) + situacao no GiroStock.
CREATE TABLE pedidos_externos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  integracao_id UUID REFERENCES integracoes_delivery(id),
  plataforma TEXT NOT NULL,
  externo_id TEXT NOT NULL,
  codigo_externo TEXT,
  -- aguardando_vinculo: ha item sem produto | importado: virou pedido | cancelado | erro
  situacao TEXT NOT NULL DEFAULT 'aguardando_vinculo' CHECK (situacao IN ('aguardando_vinculo', 'importado', 'cancelado', 'erro')),
  status_externo TEXT,
  confirmado BOOLEAN NOT NULL DEFAULT false,
  entrega_pela_plataforma BOOLEAN NOT NULL DEFAULT false,
  faltas_estoque TEXT,
  disputa JSONB,
  payload JSONB NOT NULL,
  order_id UUID REFERENCES orders(id),
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_pedido_externo ON pedidos_externos(plataforma, externo_id);
CREATE INDEX idx_pedidos_externos_tenant ON pedidos_externos(tenant_id, situacao);
CREATE INDEX idx_pedidos_externos_order ON pedidos_externos(order_id);

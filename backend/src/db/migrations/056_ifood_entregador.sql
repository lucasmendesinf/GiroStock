-- iFood Entrega Facil (Sob Demanda, modulo Shipping): pedir um entregador do iFood para um pedido de outro canal
-- (balcao/telefone/WhatsApp/cardapio/loja virtual). O endereco (com coordenadas) vai para o app do entregador.
CREATE TABLE entregas_ifood (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  integracao_id UUID NOT NULL REFERENCES integracoes_delivery(id),
  ifood_pedido_id TEXT,                 -- id do pedido criado no iFood (Shipping)
  tracking_url TEXT,                    -- pagina de acompanhamento do iFood (para o cliente)
  status TEXT NOT NULL DEFAULT 'solicitada' CHECK (status IN ('solicitada', 'buscando', 'alocado', 'indo_loja', 'na_loja', 'em_rota', 'no_destino', 'entregue', 'cancelada', 'falhou')),
  cotacao_id TEXT,
  valor NUMERIC(12,2),                  -- cobrado pelo iFood da loja (netValue da cotacao)
  distancia_m INTEGER,
  tempo_min INTEGER,
  tempo_max INTEGER,
  endereco JSONB NOT NULL,              -- endereco enviado (rua, numero, bairro, cidade, UF, CEP, complemento, referencia)
  lat NUMERIC(9,6) NOT NULL,
  lng NUMERIC(9,6) NOT NULL,
  pagamento JSONB,                      -- { tipo: pago | dinheiro | credito | debito, bandeira, troco_para, valor }
  alocar_em TIMESTAMPTZ,                -- quando o iFood aloca o entregador (preparo)
  entregador_nome TEXT,
  entregador_lat NUMERIC(9,6),
  entregador_lng NUMERIC(9,6),
  previsao_entrega TIMESTAMPTZ,
  rastreio_em TIMESTAMPTZ,
  codigo_entrega TEXT,                  -- codigo que o entregador pede ao cliente
  ultimo_evento TEXT,
  erro TEXT,
  criado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_entregas_ifood_pedido ON entregas_ifood(order_id, criado_em DESC);
CREATE UNIQUE INDEX uq_entregas_ifood_externo ON entregas_ifood(ifood_pedido_id) WHERE ifood_pedido_id IS NOT NULL;
-- uma entrega ativa por pedido
CREATE UNIQUE INDEX uq_entregas_ifood_ativa ON entregas_ifood(order_id) WHERE status NOT IN ('entregue', 'cancelada', 'falhou');

-- Endereco estruturado da entrega (o site guarda ao criar o pedido; a tela guarda ao chamar o entregador)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS entrega_endereco JSONB;

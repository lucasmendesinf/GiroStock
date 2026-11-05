-- Casa de shows e eventos, Fase 1: cadastro e agenda dos eventos e as vendas ligadas a cada um.
-- O evento acontece num setor (local de estoque, ex.: "Bar do show") com os PDVs desse setor. Enquanto o evento esta
-- ABERTO, toda venda feita naquele setor (PDV, comanda de pista, pedido) e marcada com o evento (sales.evento_id).
-- Nao ha dois eventos abertos ao mesmo tempo na empresa.
CREATE TABLE eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL CHECK (char_length(nome) >= 3),
  descricao TEXT NOT NULL DEFAULT '',
  atracoes TEXT NOT NULL DEFAULT '',
  inicio TIMESTAMPTZ NOT NULL,                       -- abertura da casa (data e hora)
  fim TIMESTAMPTZ,                                   -- encerramento previsto
  location_id UUID NOT NULL REFERENCES locations(id),         -- setor do evento (estoque e PDVs)
  deposito_id UUID REFERENCES locations(id),                  -- de onde sai a carga e para onde volta a sobra (Fase 2)
  status TEXT NOT NULL DEFAULT 'agendado' CHECK (status IN ('agendado', 'aberto', 'encerrado', 'cancelado')),
  preco_ingresso NUMERIC(12,2) CHECK (preco_ingresso IS NULL OR preco_ingresso >= 0),   -- so informativo (site)
  link_ingresso TEXT,                                                                  -- venda de ingresso fora do sistema
  publicado_site BOOLEAN NOT NULL DEFAULT false,
  aberto_em TIMESTAMPTZ, aberto_por UUID REFERENCES users(id),
  encerrado_em TIMESTAMPTZ, encerrado_por UUID REFERENCES users(id),
  cancelado_em TIMESTAMPTZ, motivo_cancelamento TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (fim IS NULL OR fim > inicio),
  CHECK (deposito_id IS NULL OR deposito_id <> location_id)
);
CREATE INDEX idx_eventos_tenant_inicio ON eventos(tenant_id, inicio);
CREATE UNIQUE INDEX uq_eventos_um_aberto ON eventos(tenant_id) WHERE status = 'aberto';

ALTER TABLE sales ADD COLUMN evento_id UUID REFERENCES eventos(id);
CREATE INDEX idx_sales_evento ON sales(evento_id) WHERE evento_id IS NOT NULL;

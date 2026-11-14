-- Entrega por raio na loja virtual: modo (bairro/raio), posicao da loja, raio, faixas de taxa por distancia,
-- coordenadas nos enderecos e nos pedidos, e cache de geocodificacao. Lojas existentes seguem em 'bairro' (nada muda).
ALTER TABLE lv_lojas ADD COLUMN IF NOT EXISTS entrega_modo TEXT NOT NULL DEFAULT 'bairro' CHECK (entrega_modo IN ('bairro', 'raio'));
ALTER TABLE lv_lojas ADD COLUMN IF NOT EXISTS loja_lat NUMERIC(9,6);
ALTER TABLE lv_lojas ADD COLUMN IF NOT EXISTS loja_lng NUMERIC(9,6);
ALTER TABLE lv_lojas ADD COLUMN IF NOT EXISTS raio_km NUMERIC(5,1) CHECK (raio_km > 0 AND raio_km <= 60);
ALTER TABLE lv_lojas ADD COLUMN IF NOT EXISTS raio_usa_faixas BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE lv_lojas ADD COLUMN IF NOT EXISTS raio_taxa_unica NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (raio_taxa_unica >= 0);
ALTER TABLE lv_lojas ADD COLUMN IF NOT EXISTS raio_margem_pino_m INTEGER NOT NULL DEFAULT 500 CHECK (raio_margem_pino_m BETWEEN 0 AND 5000);

CREATE TABLE IF NOT EXISTS lv_raio_faixas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  ate_km NUMERIC(5,1) NOT NULL CHECK (ate_km > 0),
  taxa NUMERIC(12,2) NOT NULL CHECK (taxa >= 0),
  tempo_extra_min INTEGER NOT NULL DEFAULT 0 CHECK (tempo_extra_min >= 0),
  ordem INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, ate_km)
);
CREATE INDEX IF NOT EXISTS idx_lv_raio_faixas_tenant ON lv_raio_faixas(tenant_id, ate_km);

ALTER TABLE lv_enderecos ADD COLUMN IF NOT EXISTS lat NUMERIC(9,6);
ALTER TABLE lv_enderecos ADD COLUMN IF NOT EXISTS lng NUMERIC(9,6);
ALTER TABLE lv_enderecos ADD COLUMN IF NOT EXISTS coord_origem TEXT CHECK (coord_origem IN ('cep', 'endereco', 'pino'));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS entrega_lat NUMERIC(9,6);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS entrega_lng NUMERIC(9,6);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS entrega_distancia_km NUMERIC(6,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS entrega_faixa_ate_km NUMERIC(5,1);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS entrega_coord_origem TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS entrega_aviso TEXT;

-- Cache da geocodificacao (30 dias): chave = hash do texto do endereco normalizado. Sem tenant: guarda so o texto consultado.
CREATE TABLE IF NOT EXISTS geo_cache (
  chave_hash TEXT PRIMARY KEY,
  consulta TEXT NOT NULL,
  lat NUMERIC(9,6),
  lng NUMERIC(9,6),
  precisao TEXT,
  provedor TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_geo_cache_criado ON geo_cache(criado_em);

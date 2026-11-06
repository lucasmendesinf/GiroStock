-- Loja virtual servida pelo proprio GiroStock: o mesmo servidor atende o sistema e todas as lojas. Cada loja e
-- identificada pelo endereco acessado: um subdominio da plataforma (joao.<LOJA_DOMINIO_BASE>) ou um dominio proprio
-- (www.lojadojoao.com.br) que o cliente aponta por DNS. Subdominio e dominios sao definidos pelo Master.
-- O layout (tema) e configurado pelo cliente: modelo, cores, fonte e blocos da pagina inicial.

ALTER TABLE lv_lojas ADD COLUMN subdominio TEXT;
CREATE UNIQUE INDEX uq_lv_lojas_subdominio ON lv_lojas(lower(subdominio)) WHERE subdominio IS NOT NULL;
ALTER TABLE lv_lojas ADD COLUMN tema JSONB NOT NULL DEFAULT '{}';

-- Um dominio pertence a uma loja so (tabela propria para garantir a unicidade entre empresas).
CREATE TABLE lv_dominios (
  dominio TEXT PRIMARY KEY CHECK (dominio = lower(dominio)),
  loja_id UUID NOT NULL REFERENCES lv_lojas(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lv_dominios_loja ON lv_dominios(loja_id);
INSERT INTO lv_dominios (dominio, loja_id)
  SELECT DISTINCT ON (d) d, l.id FROM lv_lojas l, unnest(l.dominios) AS d ORDER BY d, l.criado_em
  ON CONFLICT DO NOTHING;
ALTER TABLE lv_lojas DROP COLUMN dominios;

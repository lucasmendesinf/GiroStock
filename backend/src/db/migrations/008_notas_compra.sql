-- Notas de compra ja lancadas no estoque: impede lancar (ou importar o XML de) a mesma nota duas vezes.
-- A nota e identificada pelo numero (e pelo fornecedor, quando informado).
CREATE TABLE purchase_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  numero TEXT NOT NULL,
  supplier_id UUID REFERENCES suppliers(id),
  usuario_id UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_purchase_notes_tenant_numero ON purchase_notes(tenant_id, numero);

-- Notas que ja foram lancadas antes desta tabela existir (entradas com numero de nota).
INSERT INTO purchase_notes (tenant_id, numero, supplier_id, usuario_id, criado_em)
SELECT tenant_id, documento_fiscal, supplier_id, (array_agg(usuario_id ORDER BY criado_em))[1], MIN(criado_em)
FROM stock_movements
WHERE tipo = 'entrada' AND documento_fiscal IS NOT NULL AND btrim(documento_fiscal) <> '' AND sale_id IS NULL
GROUP BY tenant_id, documento_fiscal, supplier_id;

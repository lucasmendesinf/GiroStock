-- Nota fiscal, devolucao: venda cancelada fora do prazo de cancelamento da NFC-e (a SEFAZ recusa o cancelamento).
-- A venda e cancelada mesmo assim e a nota fica pendente de devolucao (lista "Precisam de devolucao"). Dali sai a NF-e de
-- devolucao (modelo 55, entrada, finalidade 4) que referencia a chave da NFC-e.
ALTER TABLE notas_fiscais ADD COLUMN pendencia TEXT CHECK (pendencia IS NULL OR pendencia IN ('devolucao'));
ALTER TABLE notas_fiscais ADD COLUMN pendencia_motivo TEXT;
ALTER TABLE notas_fiscais ADD COLUMN pendencia_em TIMESTAMPTZ;
ALTER TABLE notas_fiscais ADD COLUMN finalidade SMALLINT NOT NULL DEFAULT 1 CHECK (finalidade IN (1, 4));   -- 1 normal, 4 devolucao
ALTER TABLE notas_fiscais ADD COLUMN nota_referenciada_id UUID REFERENCES notas_fiscais(id);   -- devolucao -> nota devolvida
ALTER TABLE notas_fiscais ADD COLUMN dados JSONB;   -- dados informados na devolucao (destinatario), para reenviar com o mesmo numero
CREATE INDEX idx_notas_fiscais_pendencia ON notas_fiscais(tenant_id) WHERE pendencia IS NOT NULL;
CREATE INDEX idx_notas_fiscais_ref ON notas_fiscais(nota_referenciada_id) WHERE nota_referenciada_id IS NOT NULL;

ALTER TABLE fiscal_lojas ADD COLUMN serie_nfe INTEGER NOT NULL DEFAULT 1 CHECK (serie_nfe BETWEEN 0 AND 999);

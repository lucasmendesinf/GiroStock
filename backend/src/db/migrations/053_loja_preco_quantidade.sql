-- Preco por quantidade (pack fechado / atacado) ligado ou desligado por loja. Ex.: so a Distribuidora aplica o pack;
-- Lanchonete e Casa de Eventos (garcom, preco diferenciado) vendem sempre pelo preco da unidade.
ALTER TABLE locations ADD COLUMN aplica_preco_quantidade BOOLEAN NOT NULL DEFAULT true;

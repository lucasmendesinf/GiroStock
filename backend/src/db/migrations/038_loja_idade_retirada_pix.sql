-- Loja virtual: produtos +18 e "so retirada", aviso de idade na entrada do site e desconto no Pix.
-- +18: o cliente declara ter 18 anos ou mais ao fechar o pedido (fica registrado no pedido).
-- So retirada: o produto nao pode ser entregue nem enviado (ex.: produtos de tabaco, cuja venda por via postal a lei proibe).
ALTER TABLE lv_produtos ADD COLUMN maior_idade BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lv_produtos ADD COLUMN so_retirada BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lv_lojas ADD COLUMN site_maior_idade BOOLEAN NOT NULL DEFAULT false;   -- pergunta a idade ao entrar no site
-- Desconto no Pix pago pelo site (% sobre os produtos, depois do cupom; nao vale sobre o frete)
ALTER TABLE lv_lojas ADD COLUMN pix_desconto_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (pix_desconto_pct >= 0 AND pix_desconto_pct <= 30);
ALTER TABLE orders ADD COLUMN desconto_pix NUMERIC(12,2) NOT NULL DEFAULT 0;      -- ja incluido em orders.desconto
ALTER TABLE orders ADD COLUMN maior_idade_declarada_em TIMESTAMPTZ;               -- cliente declarou ter 18+ (pedido com produto +18)

-- Foto principal do produto no estoque e fallback para a loja virtual.
ALTER TABLE products ADD COLUMN imagem_id UUID REFERENCES lv_imagens(id) ON DELETE SET NULL;
CREATE INDEX idx_products_imagem ON products (imagem_id) WHERE imagem_id IS NOT NULL;

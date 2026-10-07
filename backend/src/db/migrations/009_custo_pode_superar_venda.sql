-- O custo do produto com receita acompanha sempre a ultima entrada dos insumos, mesmo quando
-- passa do preco de venda (a tela avisa quais produtos ficaram com custo acima da venda).
ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_venda_maior_custo;

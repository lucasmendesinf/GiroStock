-- iFood: enviar os produtos do GiroStock para o cardapio do iFood (Catalog API v2) com o codigo PDV (externalCode) = codigo
-- do produto. Assim todo pedido (teste ou real) ja chega com o codigo e entra direto (sem vincular a mao).
-- Modo teste da conexao: itens que chegam sem vinculo (pedidos de teste do iFood com itens aleatorios) usam um produto padrao.
ALTER TABLE integracoes_delivery ADD COLUMN modo_teste BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE integracoes_delivery ADD COLUMN produto_teste_id UUID REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE integracoes_delivery ADD COLUMN cardapio_enviado_em TIMESTAMPTZ;

-- Categorias do GiroStock criadas no cardapio do iFood (chave = id da categoria ou 'sem-categoria').
CREATE TABLE ifood_categorias (
  integracao_id UUID NOT NULL REFERENCES integracoes_delivery(id) ON DELETE CASCADE,
  chave TEXT NOT NULL,
  categoria_ifood_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  PRIMARY KEY (integracao_id, chave)
);

-- Produtos enviados: ids (UUID v4) que o GiroStock gerou para o item e o produto no iFood, codigo, preco e status enviados.
CREATE TABLE ifood_cardapio (
  integracao_id UUID NOT NULL REFERENCES integracoes_delivery(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  item_id UUID NOT NULL,
  produto_ifood_id UUID NOT NULL,
  codigo TEXT NOT NULL,
  categoria_ifood_id TEXT,
  preco NUMERIC(12,2),
  status TEXT,
  imagem_enviada UUID,
  enviado_em TIMESTAMPTZ,
  erro TEXT,
  PRIMARY KEY (integracao_id, product_id)
);

-- Tipo da loja (definido pelo Master pelo ramo do cliente):
--  - 'varejo':   loja virtual generica (tabacaria, informatica, roupas...): busca, grade de produtos, pagina de produto.
--  - 'cardapio': cardapio digital / delivery proprio (ramo de alimentacao): categorias com foto, lista de itens,
--                pedidos caem na tela de Pedidos (cozinha), sem taxa de plataforma.
ALTER TABLE lv_lojas ADD COLUMN tipo TEXT NOT NULL DEFAULT 'varejo' CHECK (tipo IN ('varejo', 'cardapio'));

-- Categorias no site: foto (cartoes do cardapio e vitrine), ordem e ocultar.
CREATE TABLE lv_categorias (
  category_id UUID PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  imagem_id UUID REFERENCES lv_imagens(id) ON DELETE SET NULL,
  ordem INTEGER NOT NULL DEFAULT 0,
  oculta BOOLEAN NOT NULL DEFAULT false,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lv_categorias_tenant ON lv_categorias(tenant_id);

-- Modelos de layout renomeados (varejo): classico -> grade, compacto -> lista.
UPDATE lv_lojas SET tema = jsonb_set(tema, '{modelo}', '"grade"') WHERE tema->>'modelo' = 'classico';
UPDATE lv_lojas SET tema = jsonb_set(tema, '{modelo}', '"lista"') WHERE tema->>'modelo' = 'compacto';

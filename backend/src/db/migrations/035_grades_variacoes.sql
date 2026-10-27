-- Grades de variacoes (cor, tamanho, voltagem...). Cada variacao e um PRODUTO comum (codigo, codigo de barras, preco,
-- estoque proprio, PDV, vendas, relatorios), ligado a grade. A grade guarda o nome base e os atributos com os valores.
CREATE TABLE produto_grades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL CHECK (char_length(nome) >= 3),
  categoria_id UUID REFERENCES categories(id),
  -- [{ "nome": "Cor", "valores": ["Preta", "Branca"] }, { "nome": "Tamanho", "valores": ["P", "M", "G"] }] (ate 3 atributos)
  atributos JSONB NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_produto_grades_tenant ON produto_grades(tenant_id);

ALTER TABLE products ADD COLUMN grade_id UUID REFERENCES produto_grades(id);
ALTER TABLE products ADD COLUMN variacao JSONB;   -- { "Cor": "Preta", "Tamanho": "M" }
CREATE INDEX idx_products_grade ON products(grade_id) WHERE grade_id IS NOT NULL;
CREATE UNIQUE INDEX uq_products_grade_variacao ON products(grade_id, variacao) WHERE grade_id IS NOT NULL;

-- Loja virtual: a grade e publicada inteira (um card e uma pagina com seletores). Os campos da grade sao copiados para
-- o produto de cada variacao no site (lv_produtos), que continua valendo para carrinho, pedido, frete e estoque.
CREATE TABLE lv_grades (
  grade_id UUID PRIMARY KEY REFERENCES produto_grades(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  publicado BOOLEAN NOT NULL DEFAULT true,
  nome_site TEXT,
  descricao TEXT NOT NULL DEFAULT '',
  imagens UUID[] NOT NULL DEFAULT '{}',          -- fotos gerais da grade
  atributo_foto TEXT,                            -- atributo que troca a foto (ex.: "Cor")
  fotos_por_valor JSONB NOT NULL DEFAULT '{}',   -- { "Preta": [ids], "Branca": [ids] }
  promo_pct NUMERIC(5,2) CHECK (promo_pct IS NULL OR (promo_pct > 0 AND promo_pct < 100)),  -- promocao em % (vale para todas)
  promo_inicio DATE,
  promo_fim DATE,
  destaque BOOLEAN NOT NULL DEFAULT false,
  ordem INTEGER NOT NULL DEFAULT 0,
  maior_idade BOOLEAN NOT NULL DEFAULT false,
  so_retirada BOOLEAN NOT NULL DEFAULT false,
  peso_kg NUMERIC(8,3), altura_cm NUMERIC(8,1), largura_cm NUMERIC(8,1), comprimento_cm NUMERIC(8,1),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

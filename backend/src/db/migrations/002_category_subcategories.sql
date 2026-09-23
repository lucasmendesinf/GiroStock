-- Subcategorias: uma categoria pode ter uma categoria pai (ex.: Lanchonete > Lanches)
ALTER TABLE categories ADD COLUMN parent_id UUID REFERENCES categories(id);
CREATE INDEX idx_categories_parent ON categories(tenant_id, parent_id);

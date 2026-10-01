-- Niveis de acesso configuraveis por empresa + permissoes extras por usuario.
-- Substitui o perfil fixo (enum user_role): cada nivel tem uma lista de permissoes
-- e o administrador pode criar niveis novos e ajustar os existentes.
-- '*' = todas as permissoes (nivel Administrador, que nao pode ser alterado).

CREATE TABLE access_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL,
  permissoes TEXT[] NOT NULL DEFAULT '{}',
  sistema BOOLEAN NOT NULL DEFAULT false,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_access_levels_tenant_nome ON access_levels(tenant_id, lower(nome));

-- Niveis padrao de uma empresa. Editar produtos, fornecedores e insumos fica so com o
-- Administrador; os demais niveis precisam receber essas permissoes explicitamente.
CREATE OR REPLACE FUNCTION girostock_criar_niveis_padrao(p_tenant UUID) RETURNS VOID AS $$
BEGIN
  INSERT INTO access_levels (tenant_id, nome, permissoes, sistema) VALUES
    (p_tenant, 'Administrador', ARRAY['*'], true),
    (p_tenant, 'Gerente', ARRAY['vendas.pdv','vendas.desconto','vendas.cancelar','estoque.ver','estoque.movimentar',
                                'produtos.criar','fornecedores.criar','insumos.criar','relatorios.ver'], true),
    (p_tenant, 'Caixa/Operador', ARRAY['vendas.pdv','vendas.desconto'], true),
    (p_tenant, 'Estoque', ARRAY['estoque.ver','estoque.movimentar','produtos.criar','fornecedores.criar','insumos.criar'], true),
    (p_tenant, 'Financeiro', ARRAY['relatorios.ver'], true),
    (p_tenant, 'Lanchonete/Cozinha', ARRAY[]::TEXT[], true)
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;

SELECT girostock_criar_niveis_padrao(id) FROM tenants;

ALTER TABLE users ADD COLUMN access_level_id UUID REFERENCES access_levels(id);
UPDATE users u SET access_level_id = al.id
FROM access_levels al
WHERE al.tenant_id = u.tenant_id AND al.nome = u.perfil::text;
ALTER TABLE users ALTER COLUMN access_level_id SET NOT NULL;
CREATE INDEX idx_users_access_level ON users(access_level_id);

-- Permissoes concedidas a um usuario alem das do nivel dele.
ALTER TABLE users ADD COLUMN permissoes_extra TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE users DROP COLUMN perfil;
DROP TYPE user_role;

-- Descricao opcional do produto (editavel por quem tem permissao).
ALTER TABLE products ADD COLUMN descricao TEXT;

-- Permissoes de EDICAO de cadastros (EditarProdutos, EditarFornecedores, EditarInsumos) e descricao do produto.
--
-- Padrao novo: so o Administrador edita cadastros. Para NAO mudar a operacao de hoje, cada usuario existente que hoje tem a area
-- Estoque (pelo perfil Gerente/Estoque/Lanchonete-Cozinha, ou por ajuste individual) e nao e Administrador recebe, em users.permissoes,
-- os tres ajustes = true (mesclados com os ajustes que ja existiam). Usuarios criados depois seguem o padrao novo. Idempotente.
UPDATE users
   SET permissoes = COALESCE(permissoes, '{}'::jsonb) || '{"EditarProdutos": true, "EditarFornecedores": true, "EditarInsumos": true}'::jsonb
 WHERE perfil::text NOT IN ('Administrador', 'Master', 'Garçom')
   AND (
        (perfil::text IN ('Gerente', 'Estoque', 'Lanchonete/Cozinha') AND COALESCE(permissoes ->> 'Estoque', 'true') <> 'false')
        OR permissoes ->> 'Estoque' = 'true'
       );

ALTER TABLE products ADD COLUMN IF NOT EXISTS descricao TEXT;

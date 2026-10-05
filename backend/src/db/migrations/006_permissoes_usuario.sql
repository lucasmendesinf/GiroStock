-- Ajustes de permissao por usuario: so as diferencas em relacao ao padrao do perfil
-- (ex: {"Vendas": true} libera o PDV para um usuario cujo perfil nao vende).
ALTER TABLE users ADD COLUMN permissoes JSONB;

-- Dados de contato da empresa, editaveis pelo administrador dela (nao interferem em nada do sistema).
ALTER TABLE tenants ADD COLUMN email_contato TEXT;
ALTER TABLE tenants ADD COLUMN telefone TEXT;
ALTER TABLE tenants ADD COLUMN responsavel TEXT;

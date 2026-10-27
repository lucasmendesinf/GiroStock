-- Perfil Garçom (app de comandas no celular). O valor novo do enum fica nesta migration, sozinha: o PostgreSQL nao deixa usar o valor na mesma transacao em que ele nasce.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Garçom';

-- Perfil Master (dono da plataforma): fora das empresas, criado so por script (npm run master).
-- O valor novo do enum nao pode ser usado na mesma transacao: ele so e usado depois, pelo script.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Master';

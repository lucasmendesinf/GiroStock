-- Cardapio digital para o cliente final: capa da loja, conta por telefone (login por codigo) e formas de pagamento
-- mais detalhadas (cartao de credito e de debito).

-- Capa (imagem larga do topo do cardapio).
ALTER TABLE lv_lojas ADD COLUMN IF NOT EXISTS capa_id UUID REFERENCES lv_imagens(id) ON DELETE SET NULL;

-- Conta pelo telefone: e-mail e senha passam a ser opcionais (as contas antigas continuam como estao).
ALTER TABLE lv_contas ALTER COLUMN email DROP NOT NULL;
ALTER TABLE lv_contas ALTER COLUMN senha_hash DROP NOT NULL;

-- Telefone unico por empresa (so contas ativas). Se ja houver contas repetidas, o indice nao e criado e o login
-- por codigo usa a conta mais recente daquele telefone.
DO $$
BEGIN
  CREATE UNIQUE INDEX uq_lv_contas_telefone ON lv_contas(tenant_id, telefone) WHERE ativo AND telefone <> '';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'lv_contas: telefones repetidos; indice unico de telefone nao criado';
END $$;

-- Codigos de login (so o hash; vale 10 minutos, ate 3 tentativas, uso unico).
CREATE TABLE IF NOT EXISTS lv_login_codigos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  telefone TEXT NOT NULL,
  codigo_hash TEXT NOT NULL,
  expira_em TIMESTAMPTZ NOT NULL,
  tentativas INTEGER NOT NULL DEFAULT 0,
  enviado_via TEXT,
  ip TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  usado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_lv_login_codigos_tel ON lv_login_codigos(tenant_id, telefone, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_lv_login_codigos_exp ON lv_login_codigos(expira_em);

-- Pagamento na entrega: 'cartao' vira credito + debito.
UPDATE lv_lojas
   SET pagamentos = jsonb_set(pagamentos, '{na_entrega}', ((pagamentos->'na_entrega') - 'cartao') || '["cartao_credito", "cartao_debito"]'::jsonb)
 WHERE pagamentos->'na_entrega' @> '["cartao"]'::jsonb;
ALTER TABLE lv_lojas ALTER COLUMN pagamentos SET DEFAULT '{"pix_online": false, "cartao_online": false, "debito_online": false, "na_entrega": ["dinheiro", "pix", "cartao_credito", "cartao_debito"]}';

-- Pedido pago online tambem pode ser no debito.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%pagamento_online%'
  LOOP
    EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE orders ADD CONSTRAINT orders_pagamento_online_check CHECK (pagamento_online IN ('pix', 'cartao', 'debito'));

-- Loja virtual (modulo "loja_virtual"): o site da loja e um projeto separado, o mesmo para todas as empresas (so o
-- layout muda). Ele conversa com o GiroStock pela API publica /api/loja/v1, identificado pela chave da loja.
-- Aqui fica tudo o que a empresa gerencia: configuracao, produtos publicados (fotos, descricao, promocao), entrega por
-- bairro, cupons, contas dos clientes do site e pagamentos online (Mercado Pago, com as credenciais do lojista).
-- Uma loja por empresa. Os pedidos do site sao pedidos comuns (origem 'loja_virtual') e caem na tela de Pedidos.

CREATE TABLE lv_imagens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  dados BYTEA NOT NULL,
  tamanho INTEGER NOT NULL,
  largura INTEGER,
  altura INTEGER,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lv_imagens_tenant ON lv_imagens(tenant_id);

CREATE TABLE lv_lojas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id),
  -- estabelecimento de onde sai o estoque (disponibilidade) e onde o pedido e preparado/finalizado
  location_id UUID REFERENCES locations(id),
  publicada BOOLEAN NOT NULL DEFAULT false,      -- site no ar (aceitando visitas)
  pausada BOOLEAN NOT NULL DEFAULT false,        -- no ar, mas sem aceitar pedidos agora ("fechada temporariamente")
  nome TEXT NOT NULL DEFAULT '',
  descricao TEXT NOT NULL DEFAULT '',
  logo_id UUID REFERENCES lv_imagens(id) ON DELETE SET NULL,
  banners JSONB NOT NULL DEFAULT '[]',          -- [{ imagem_id, titulo, link }]
  telefone TEXT NOT NULL DEFAULT '',
  whatsapp TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  endereco TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  aviso TEXT NOT NULL DEFAULT '',               -- faixa de aviso no topo do site
  dominios TEXT[] NOT NULL DEFAULT '{}',        -- dominios do site (liberados no CORS)
  horarios JSONB NOT NULL DEFAULT '{}',         -- {"0": [{"de":"18:00","ate":"23:30"}], ... } (0 = domingo); vazio = sempre aberta
  aceita_retirada BOOLEAN NOT NULL DEFAULT true,
  aceita_entrega BOOLEAN NOT NULL DEFAULT true,
  pedido_minimo NUMERIC(12,2) NOT NULL DEFAULT 0,
  tempo_preparo_min INTEGER NOT NULL DEFAULT 30,
  tempo_entrega_min INTEGER NOT NULL DEFAULT 40,
  -- bairro fora da lista: taxa padrao (NULL = so entrega nos bairros cadastrados)
  taxa_outros_bairros NUMERIC(12,2),
  -- formas aceitas: pagar no site (Mercado Pago) e pagar na entrega/retirada
  pagamentos JSONB NOT NULL DEFAULT '{"pix_online": false, "cartao_online": false, "na_entrega": ["dinheiro", "pix", "cartao"]}',
  parcelas_max INTEGER NOT NULL DEFAULT 1 CHECK (parcelas_max BETWEEN 1 AND 12),
  pix_expira_min INTEGER NOT NULL DEFAULT 30 CHECK (pix_expira_min BETWEEN 5 AND 1440),
  -- chave de acesso da API (guardada so o hash; o prefixo identifica a chave na tela)
  api_chave_hash TEXT,
  api_chave_prefixo TEXT,
  api_chave_criada_em TIMESTAMPTZ,
  -- Mercado Pago (conta do lojista): access token e segredo do webhook cifrados
  mp_access_token_cript TEXT,
  mp_public_key TEXT,
  mp_webhook_secret_cript TEXT,
  mp_conta TEXT,                                 -- nickname/e-mail da conta conferida no teste de conexao
  mp_conectado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_lv_lojas_chave ON lv_lojas(api_chave_hash) WHERE api_chave_hash IS NOT NULL;

-- Produto publicado no site (o cadastro, o preco de venda e o estoque continuam os do sistema).
CREATE TABLE lv_produtos (
  product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  publicado BOOLEAN NOT NULL DEFAULT true,
  nome_site TEXT,                                -- nome no site (NULL = nome do cadastro)
  descricao TEXT NOT NULL DEFAULT '',
  imagens UUID[] NOT NULL DEFAULT '{}',          -- ordem das fotos (a primeira e a principal)
  preco_promocional NUMERIC(12,2) CHECK (preco_promocional IS NULL OR preco_promocional > 0),
  promo_inicio DATE,
  promo_fim DATE,
  destaque BOOLEAN NOT NULL DEFAULT false,
  ordem INTEGER NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lv_produtos_tenant ON lv_produtos(tenant_id, publicado);

-- Bairros atendidos e taxa de entrega de cada um.
CREATE TABLE lv_regioes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL,
  taxa NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (taxa >= 0),
  tempo_extra_min INTEGER NOT NULL DEFAULT 0,
  pedido_minimo NUMERIC(12,2),
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_lv_regioes_nome ON lv_regioes(tenant_id, lower(nome));

CREATE TABLE lv_cupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  codigo TEXT NOT NULL,
  descricao TEXT NOT NULL DEFAULT '',
  tipo TEXT NOT NULL CHECK (tipo IN ('percentual', 'valor', 'frete_gratis')),
  valor NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (valor >= 0),
  desconto_maximo NUMERIC(12,2),                 -- teto do desconto percentual
  pedido_minimo NUMERIC(12,2) NOT NULL DEFAULT 0,
  inicio DATE,
  fim DATE,
  limite_total INTEGER,                          -- usos no total (NULL = sem limite)
  limite_por_cliente INTEGER DEFAULT 1,          -- usos por conta (NULL = sem limite)
  primeira_compra BOOLEAN NOT NULL DEFAULT false,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_lv_cupons_codigo ON lv_cupons(tenant_id, upper(codigo));

-- Conta do cliente no site (login por e-mail e senha). Ligada ao cadastro de Clientes do sistema pelo telefone.
CREATE TABLE lv_contas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  customer_id UUID REFERENCES customers(id),
  nome TEXT NOT NULL,
  email TEXT NOT NULL,
  telefone TEXT NOT NULL,
  cpf TEXT,
  senha_hash TEXT NOT NULL,
  aceita_mensagens BOOLEAN NOT NULL DEFAULT false,
  ativo BOOLEAN NOT NULL DEFAULT true,
  sessoes_validas_desde TIMESTAMPTZ NOT NULL DEFAULT now(),
  reset_codigo_hash TEXT,
  reset_expira_em TIMESTAMPTZ,
  reset_tentativas INTEGER NOT NULL DEFAULT 0,
  ultimo_login_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_lv_contas_email ON lv_contas(tenant_id, lower(email));
CREATE INDEX idx_lv_contas_customer ON lv_contas(customer_id);

CREATE TABLE lv_enderecos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id UUID NOT NULL REFERENCES lv_contas(id) ON DELETE CASCADE,
  rotulo TEXT NOT NULL DEFAULT 'Casa',
  cep TEXT NOT NULL DEFAULT '',
  logradouro TEXT NOT NULL,
  numero TEXT NOT NULL DEFAULT '',
  complemento TEXT NOT NULL DEFAULT '',
  bairro TEXT NOT NULL,
  cidade TEXT NOT NULL DEFAULT '',
  uf TEXT NOT NULL DEFAULT '',
  referencia TEXT NOT NULL DEFAULT '',
  padrao BOOLEAN NOT NULL DEFAULT false,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lv_enderecos_conta ON lv_enderecos(conta_id);

-- Pedido do site: canal 'loja_virtual', conta do cliente, cupom e situacao do pagamento online.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%telefone%whatsapp%'
  LOOP
    EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE orders ADD CONSTRAINT orders_origem_check CHECK (origem IN ('balcao', 'telefone', 'whatsapp', 'ifood', '99food', 'loja_virtual'));
ALTER TABLE orders ADD COLUMN lv_conta_id UUID REFERENCES lv_contas(id);
ALTER TABLE orders ADD COLUMN cupom_id UUID REFERENCES lv_cupons(id);
ALTER TABLE orders ADD COLUMN cupom_codigo TEXT;
ALTER TABLE orders ADD COLUMN troco_para NUMERIC(12,2);
-- pagamento no site: NULL = paga na entrega/retirada; 'pendente' | 'aprovado' | 'recusado' | 'expirado' | 'estornado'
ALTER TABLE orders ADD COLUMN pagamento_online TEXT CHECK (pagamento_online IN ('pix', 'cartao'));
ALTER TABLE orders ADD COLUMN pagamento_status TEXT CHECK (pagamento_status IN ('pendente', 'aprovado', 'recusado', 'expirado', 'estornado'));
CREATE INDEX idx_orders_lv_conta ON orders(lv_conta_id) WHERE lv_conta_id IS NOT NULL;
CREATE INDEX idx_orders_cupom ON orders(cupom_id) WHERE cupom_id IS NOT NULL;
CREATE INDEX idx_orders_pagamento_pendente ON orders(pagamento_status) WHERE pagamento_status = 'pendente';

-- Cada tentativa de pagamento no Mercado Pago (um pedido pode ter um Pix expirado e depois um cartao aprovado).
CREATE TABLE lv_pagamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  order_id UUID NOT NULL REFERENCES orders(id),
  provedor TEXT NOT NULL DEFAULT 'mercadopago',
  provedor_id TEXT,
  metodo TEXT NOT NULL CHECK (metodo IN ('pix', 'cartao')),
  status TEXT NOT NULL,                          -- status do Mercado Pago (pending, approved, rejected, cancelled, refunded...)
  status_detalhe TEXT,
  valor NUMERIC(12,2) NOT NULL,
  parcelas INTEGER,
  bandeira TEXT,
  final_cartao TEXT,
  pix_copia_cola TEXT,
  pix_qr_base64 TEXT,
  expira_em TIMESTAMPTZ,
  aprovado_em TIMESTAMPTZ,
  estornado_em TIMESTAMPTZ,
  resposta JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lv_pagamentos_order ON lv_pagamentos(order_id);
CREATE UNIQUE INDEX uq_lv_pagamentos_provedor ON lv_pagamentos(provedor, provedor_id) WHERE provedor_id IS NOT NULL;

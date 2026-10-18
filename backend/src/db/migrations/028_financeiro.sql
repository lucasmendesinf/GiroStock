-- Financeiro (modulo "financeiro"): contas a pagar e a receber, contas financeiras (banco/caixa/carteira),
-- prazos e taxas de recebimento das vendas, fluxo de caixa e resultado do mes.
-- As vendas NAO viram titulos: o fluxo e o resultado leem as vendas direto, com o prazo e a taxa da forma de pagamento.

-- Categorias de receita/despesa. entra_no_resultado = false para compra de mercadoria para revenda
-- (o custo dela ja entra no resultado pelo custo das mercadorias vendidas).
CREATE TABLE fin_categorias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('receita', 'despesa')),
  nome TEXT NOT NULL,
  entra_no_resultado BOOLEAN NOT NULL DEFAULT true,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_fin_categoria ON fin_categorias(tenant_id, tipo, lower(nome));

-- Onde o dinheiro esta: conta no banco, caixa (cofre) da loja, carteira digital.
CREATE TABLE fin_contas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'banco' CHECK (tipo IN ('banco', 'caixa', 'carteira')),
  saldo_inicial NUMERIC(14,2) NOT NULL DEFAULT 0,
  saldo_inicial_em DATE NOT NULL DEFAULT CURRENT_DATE,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_fin_conta ON fin_contas(tenant_id, lower(nome));

-- Conta a pagar ou a receber (uma linha por parcela). Situacao: cancelado > pago > vencido > aberto.
CREATE TABLE fin_titulos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('pagar', 'receber')),
  descricao TEXT NOT NULL,
  categoria_id UUID REFERENCES fin_categorias(id),
  supplier_id UUID REFERENCES suppliers(id),
  customer_id UUID REFERENCES customers(id),
  location_id UUID REFERENCES locations(id),
  valor NUMERIC(14,2) NOT NULL CHECK (valor > 0),
  vencimento DATE NOT NULL,
  competencia DATE NOT NULL,
  documento TEXT,
  observacao TEXT,
  parcela INT NOT NULL DEFAULT 1,
  parcelas INT NOT NULL DEFAULT 1,
  grupo_id UUID,
  origem TEXT NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual', 'nota')),
  pago_em DATE,
  valor_pago NUMERIC(14,2),
  conta_id UUID REFERENCES fin_contas(id),
  forma_pagamento TEXT,
  cancelado_em TIMESTAMPTZ,
  motivo_cancelamento TEXT,
  criado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_fin_titulos_venc ON fin_titulos(tenant_id, tipo, vencimento) WHERE cancelado_em IS NULL;
CREATE INDEX idx_fin_titulos_grupo ON fin_titulos(grupo_id) WHERE grupo_id IS NOT NULL;
CREATE INDEX idx_fin_titulos_pago ON fin_titulos(tenant_id, pago_em) WHERE pago_em IS NOT NULL;

-- Quando e quanto cai de cada forma de pagamento das vendas (ex.: credito em 30 dias com 3,49% de taxa) e em qual conta.
-- forma: dinheiro | pix | cartao_debito | cartao_credito | ifood | 99food
CREATE TABLE fin_formas_recebimento (
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  forma TEXT NOT NULL,
  prazo_dias INT NOT NULL DEFAULT 0 CHECK (prazo_dias BETWEEN 0 AND 365),
  taxa_pct NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (taxa_pct >= 0 AND taxa_pct < 100),
  conta_id UUID REFERENCES fin_contas(id),
  PRIMARY KEY (tenant_id, forma)
);

-- Nenhum plano ganha o financeiro sozinho: o Master libera por plano ou por empresa.

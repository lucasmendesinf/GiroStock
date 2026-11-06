-- Nota fiscal (modulo "nota_fiscal"), etapa 1-2: NFC-e (cupom fiscal eletronico, modelo 65) emitida direto na SEFAZ com a
-- NFePHP (backend/fiscal/motor.php), sem intermediario e sem custo por nota. Cada loja (location) tem a sua configuracao
-- fiscal (CNPJ/IE, certificado A1, CSC, serie) e escolhe o ambiente: homologacao (notas de TESTE, sem valor fiscal) ou
-- producao. No PDV: emitir cupom fiscal ou so o cupom de sempre (nao fiscal).

CREATE TABLE fiscal_lojas (
  location_id UUID PRIMARY KEY REFERENCES locations(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  ambiente TEXT NOT NULL DEFAULT 'homologacao' CHECK (ambiente IN ('homologacao', 'producao')),
  modo_pdv TEXT NOT NULL DEFAULT 'perguntar' CHECK (modo_pdv IN ('desligado', 'perguntar', 'sempre')),
  cnpj VARCHAR(14) NOT NULL CHECK (cnpj ~ '^[0-9]{14}$'),
  ie TEXT NOT NULL,
  razao_social TEXT NOT NULL,
  nome_fantasia TEXT NOT NULL DEFAULT '',
  crt SMALLINT NOT NULL DEFAULT 1 CHECK (crt IN (1, 2, 3, 4)),   -- 1 = Simples Nacional
  logradouro TEXT NOT NULL,
  numero TEXT NOT NULL,
  complemento TEXT NOT NULL DEFAULT '',
  bairro TEXT NOT NULL,
  cod_municipio VARCHAR(7) NOT NULL CHECK (cod_municipio ~ '^[0-9]{7}$'),   -- IBGE (Curitiba = 4106902)
  municipio TEXT NOT NULL,
  uf CHAR(2) NOT NULL DEFAULT 'PR',
  cep VARCHAR(8) NOT NULL CHECK (cep ~ '^[0-9]{8}$'),
  telefone TEXT NOT NULL DEFAULT '',
  serie_nfce INTEGER NOT NULL DEFAULT 1 CHECK (serie_nfce BETWEEN 0 AND 999),
  cert_cript TEXT,                 -- certificado A1 (.pfx em base64), cifrado
  cert_senha_cript TEXT,
  cert_titular TEXT,
  cert_validade DATE,
  csc_homolog_cript TEXT, csc_homolog_id TEXT,     -- CSC (codigo de seguranca do contribuinte) de cada ambiente
  csc_prod_cript TEXT, csc_prod_id TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Numeracao por CNPJ, ambiente, modelo e serie (lojas com o mesmo CNPJ e a mesma serie dividem a sequencia).
CREATE TABLE fiscal_numeracao (
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  cnpj VARCHAR(14) NOT NULL,
  ambiente TEXT NOT NULL,
  modelo SMALLINT NOT NULL,
  serie INTEGER NOT NULL,
  proximo INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, cnpj, ambiente, modelo, serie)
);

-- Perfil fiscal: a tributacao que o contador define uma vez (ex.: "Bebida com ST" = CFOP 5405 / CSOSN 500).
CREATE TABLE perfis_fiscais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL CHECK (char_length(nome) >= 2),
  cfop VARCHAR(4) NOT NULL DEFAULT '5102' CHECK (cfop ~ '^[0-9]{4}$'),
  csosn VARCHAR(3) NOT NULL DEFAULT '102' CHECK (csosn IN ('101', '102', '103', '201', '202', '203', '300', '400', '500', '900')),
  origem SMALLINT NOT NULL DEFAULT 0 CHECK (origem BETWEEN 0 AND 8),
  cst_pis VARCHAR(2) NOT NULL DEFAULT '49',
  cst_cofins VARCHAR(2) NOT NULL DEFAULT '49',
  padrao BOOLEAN NOT NULL DEFAULT false,      -- usado pelos produtos sem perfil (nem no produto nem na categoria)
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_perfis_fiscais_nome ON perfis_fiscais(tenant_id, lower(nome));
CREATE UNIQUE INDEX uq_perfis_fiscais_padrao ON perfis_fiscais(tenant_id) WHERE padrao;

ALTER TABLE products ADD COLUMN ncm VARCHAR(8) CHECK (ncm IS NULL OR ncm ~ '^[0-9]{8}$');
ALTER TABLE products ADD COLUMN cest VARCHAR(7) CHECK (cest IS NULL OR cest ~ '^[0-9]{7}$');
ALTER TABLE products ADD COLUMN perfil_fiscal_id UUID REFERENCES perfis_fiscais(id);
ALTER TABLE categories ADD COLUMN perfil_fiscal_id UUID REFERENCES perfis_fiscais(id);

CREATE TABLE notas_fiscais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  sale_id UUID REFERENCES sales(id),
  modelo SMALLINT NOT NULL DEFAULT 65,
  ambiente TEXT NOT NULL CHECK (ambiente IN ('homologacao', 'producao')),
  cnpj VARCHAR(14) NOT NULL,
  serie INTEGER NOT NULL,
  numero INTEGER NOT NULL,
  chave VARCHAR(44),
  situacao TEXT NOT NULL DEFAULT 'processando'
    CHECK (situacao IN ('processando', 'autorizada', 'contingencia', 'rejeitada', 'erro', 'cancelada')),
  cstat TEXT,
  motivo TEXT,
  protocolo TEXT,
  xml TEXT,
  qrcode TEXT,
  url_consulta TEXT,
  cpf VARCHAR(14),
  valor NUMERIC(12,2) NOT NULL,
  tentativas INTEGER NOT NULL DEFAULT 0,
  emitida_por UUID REFERENCES users(id),
  emitida_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  autorizada_em TIMESTAMPTZ,
  cancelada_em TIMESTAMPTZ,
  cancel_justificativa TEXT,
  cancel_protocolo TEXT,
  UNIQUE (tenant_id, cnpj, ambiente, modelo, serie, numero)
);
CREATE INDEX idx_notas_fiscais_venda ON notas_fiscais(sale_id);
CREATE INDEX idx_notas_fiscais_lista ON notas_fiscais(tenant_id, emitida_em DESC);
CREATE INDEX idx_notas_fiscais_pendentes ON notas_fiscais(situacao) WHERE situacao IN ('contingencia', 'processando');

-- WhatsApp, etapa 2: campanhas de marketing pela API oficial (modelos de marketing aprovados pela Meta), com um cupom
-- individual por cliente (codigo proprio, uso unico, validade) e "SAIR" respondido no WhatsApp tirando o consentimento.
CREATE TABLE whatsapp_campanhas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nome TEXT NOT NULL,
  segmento TEXT,                         -- segmento de clientes (risco, inativo, aniversario, vip...) ou NULL (escolhidos)
  modelo TEXT NOT NULL,                  -- chave do modelo de marketing (volta | aniversario | oferta_cupom | oferta)
  oferta TEXT,                           -- texto livre da oferta (modelos de oferta)
  cupom_tipo TEXT CHECK (cupom_tipo IN ('percentual', 'valor', 'frete_gratis')),
  cupom_valor NUMERIC(12,2),
  cupom_pedido_minimo NUMERIC(12,2) NOT NULL DEFAULT 0,
  cupom_validade_dias INTEGER,
  cupom_prefixo TEXT,
  status TEXT NOT NULL DEFAULT 'enviando' CHECK (status IN ('enviando', 'concluida', 'cancelada')),
  total INTEGER NOT NULL DEFAULT 0,
  criado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_em TIMESTAMPTZ
);
CREATE INDEX idx_whatsapp_campanhas ON whatsapp_campanhas(tenant_id, criado_em DESC);

-- Cupom individual: so o cliente dono usa (pelo cadastro dele ou pelo celular da conta no site/cardapio).
ALTER TABLE lv_cupons ADD COLUMN customer_id UUID REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE lv_cupons ADD COLUMN campanha_id UUID REFERENCES whatsapp_campanhas(id) ON DELETE SET NULL;
CREATE INDEX idx_lv_cupons_campanha ON lv_cupons(campanha_id) WHERE campanha_id IS NOT NULL;

-- Mensagens de campanha: entram "na_fila" e saem aos poucos (o envio respeita o ritmo da Meta).
ALTER TABLE whatsapp_mensagens ADD COLUMN campanha_id UUID REFERENCES whatsapp_campanhas(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_mensagens ADD COLUMN customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE whatsapp_mensagens ADD COLUMN cupom_id UUID REFERENCES lv_cupons(id) ON DELETE SET NULL;
ALTER TABLE whatsapp_mensagens ADD COLUMN parametros JSONB;
ALTER TABLE whatsapp_mensagens DROP CONSTRAINT whatsapp_mensagens_situacao_check;
ALTER TABLE whatsapp_mensagens ADD CONSTRAINT whatsapp_mensagens_situacao_check CHECK (situacao IN ('na_fila', 'enviada', 'entregue', 'lida', 'falhou', 'ignorada'));
CREATE INDEX idx_whatsapp_msg_fila ON whatsapp_mensagens(criado_em) WHERE situacao = 'na_fila';
CREATE INDEX idx_whatsapp_msg_campanha ON whatsapp_mensagens(campanha_id) WHERE campanha_id IS NOT NULL;
CREATE INDEX idx_whatsapp_msg_cliente ON whatsapp_mensagens(customer_id, criado_em DESC) WHERE customer_id IS NOT NULL;

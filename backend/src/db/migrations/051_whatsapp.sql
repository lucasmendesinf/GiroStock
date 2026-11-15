-- WhatsApp (API oficial da Meta, Cloud API), etapa 1: conectar o numero da empresa (cadastro incorporado da Meta, com
-- coexistencia: o mesmo numero continua no WhatsApp Business do celular) e avisar o cliente de cada etapa do pedido.
CREATE TABLE whatsapp_contas (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id),
  status TEXT NOT NULL DEFAULT 'conectado' CHECK (status IN ('conectado', 'desconectado', 'erro')),
  waba_id TEXT NOT NULL,                 -- conta WhatsApp Business da empresa (na Meta)
  phone_number_id TEXT NOT NULL,         -- id do numero na Cloud API
  numero_exibicao TEXT,                  -- "+55 41 99520-9684"
  nome_verificado TEXT,                  -- nome que aparece para o cliente
  coexistencia BOOLEAN NOT NULL DEFAULT true,  -- numero tambem no app WhatsApp Business do celular
  token_cript TEXT NOT NULL,             -- token de acesso da empresa (cifrado)
  avisos JSONB NOT NULL DEFAULT '{"recebido": true, "em_preparo": true, "pronto_retirada": true, "saiu_entrega": true, "entregue": false, "cancelado": true}',
  modelos JSONB NOT NULL DEFAULT '{}',   -- { girostock_pedido_recebido: 'APPROVED' | 'PENDING' | 'REJECTED', ... }
  modelos_conferidos_em TIMESTAMPTZ,
  ultimo_erro TEXT,
  conectado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  conectado_por UUID REFERENCES users(id),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_whatsapp_numero ON whatsapp_contas(phone_number_id) WHERE status = 'conectado';

-- Mensagens enviadas (avisos do pedido e testes) com a situacao que a Meta informa (enviada, entregue, lida, falhou).
CREATE TABLE whatsapp_mensagens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  log_id UUID,                           -- order_status_log que gerou o aviso (cada mudanca avisa uma vez so)
  evento TEXT NOT NULL,                  -- recebido | em_preparo | pronto_retirada | saiu_entrega | entregue | cancelado | teste
  telefone TEXT NOT NULL,
  modelo TEXT,
  wamid TEXT,                            -- id da mensagem na Meta
  situacao TEXT NOT NULL CHECK (situacao IN ('enviada', 'entregue', 'lida', 'falhou', 'ignorada')),
  motivo TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_whatsapp_msg_log ON whatsapp_mensagens(log_id) WHERE log_id IS NOT NULL;
CREATE INDEX idx_whatsapp_msg_wamid ON whatsapp_mensagens(wamid) WHERE wamid IS NOT NULL;
CREATE INDEX idx_whatsapp_msg_lista ON whatsapp_mensagens(tenant_id, criado_em DESC);
CREATE INDEX idx_whatsapp_msg_pedido ON whatsapp_mensagens(order_id);

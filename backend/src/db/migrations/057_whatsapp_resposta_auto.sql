-- WhatsApp: resposta automatica com o link do cardapio quando o cliente manda mensagem (no maximo 1 vez a cada X horas
-- por cliente, para nao atrapalhar a conversa com a equipe no WhatsApp Business do celular).
ALTER TABLE whatsapp_contas ADD COLUMN resposta_auto BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE whatsapp_contas ADD COLUMN resposta_texto TEXT;
ALTER TABLE whatsapp_contas ADD COLUMN resposta_link TEXT;              -- endereco do cardapio digitado (senao, o da loja virtual)
ALTER TABLE whatsapp_contas ADD COLUMN resposta_intervalo_horas INTEGER NOT NULL DEFAULT 12 CHECK (resposta_intervalo_horas BETWEEN 1 AND 168);
CREATE INDEX idx_whatsapp_msg_resposta ON whatsapp_mensagens(tenant_id, telefone, criado_em DESC) WHERE evento = 'resposta_auto';

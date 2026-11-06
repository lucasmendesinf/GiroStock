-- Casa de shows e eventos, Fase 4: divulgacao no site do cliente.
-- Foto do evento (mesmo armazenamento das fotos da loja virtual) e a agenda publica da empresa: uma chave publica (vai no
-- codigo do site, nao e segredo) que o site usa para listar os eventos marcados "Divulgar no site".
ALTER TABLE eventos ADD COLUMN imagem_id UUID REFERENCES lv_imagens(id);

CREATE TABLE eventos_agenda (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id),
  chave TEXT NOT NULL UNIQUE,
  ativa BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

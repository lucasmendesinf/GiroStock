-- Casa de shows e eventos, Fase 4: divulgacao no site do cliente (site feito e hospedado pela Calutec).
-- Foto/banner do evento (mesmo armazenamento das fotos da loja virtual), pop-up do banner no site em um periodo escolhido e
-- a chave publica da agenda da empresa (configurada pelo Master; o site a usa para buscar os eventos e o pop-up).
ALTER TABLE eventos ADD COLUMN imagem_id UUID REFERENCES lv_imagens(id);
ALTER TABLE eventos ADD COLUMN popup_site BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE eventos ADD COLUMN popup_inicio DATE;
ALTER TABLE eventos ADD COLUMN popup_fim DATE;
ALTER TABLE eventos ADD CONSTRAINT eventos_popup_periodo CHECK (popup_inicio IS NULL OR popup_fim IS NULL OR popup_fim >= popup_inicio);

CREATE TABLE eventos_agenda (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id),
  chave TEXT NOT NULL UNIQUE,
  ativa BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

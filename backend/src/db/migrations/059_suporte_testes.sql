-- "Testar sem gravar" do suporte do Master: a empresa atendida e copiada (parcial: cadastros + ultimos 30 dias) para o
-- banco de teste e o Master testa la. Esta tabela (na producao) controla cada teste para apagar a copia no fim:
-- ao encerrar o teste, ao voltar ao suporte, quando a sessao de suporte acaba ou depois de 2 horas parado.
CREATE TABLE suporte_testes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_suporte_id UUID NOT NULL REFERENCES sessoes_suporte(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  master_id UUID NOT NULL REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_uso_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  encerrado_em TIMESTAMPTZ,
  encerrado_por TEXT,
  apagado_em TIMESTAMPTZ,
  contagens JSONB
);
CREATE INDEX suporte_testes_abertos ON suporte_testes (tenant_id) WHERE apagado_em IS NULL;

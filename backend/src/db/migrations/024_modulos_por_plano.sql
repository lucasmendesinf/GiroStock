-- Modulos (segmentos) por plano e por empresa: PDV, Lanchonete, Pedidos, Clientes e os das proximas etapas
-- (iFood/99Food, Eventos, Loja virtual, Financeiro). Catalogo em backend/src/config/modulos.js.
-- Nada muda para quem ja usa: os planos existentes passam a ter as chaves explicitas com o mesmo comportamento
-- de antes (PDV e Lanchonete sempre existiram; Pedidos/Clientes seguem como estavam; modulos futuros desligados).

UPDATE planos
   SET recursos = jsonb_build_object('pdv', true, 'lanchonete', true, 'delivery_apps', false, 'eventos', false, 'loja_virtual', false, 'financeiro', false)
                  || COALESCE(recursos, '{}'::jsonb);

-- Pacotes prontos para vender (o Master pode editar limites e modulos em Configuracoes > Planos).
INSERT INTO planos (codigo, nome, max_lojas, max_usuarios, max_pdvs, recursos) VALUES
  ('so_pdv', 'Só PDV (varejo/distribuidora)', 1, 3, 2,
   '{"pdv": true, "lanchonete": false, "pedidos": false, "clientes": false, "delivery_apps": false, "eventos": false, "loja_virtual": false, "financeiro": false}'),
  ('lanchonete', 'Lanchonete', 1, 5, 2,
   '{"pdv": true, "lanchonete": true, "pedidos": true, "clientes": true, "delivery_apps": false, "eventos": false, "loja_virtual": false, "financeiro": false}')
ON CONFLICT (codigo) DO NOTHING;

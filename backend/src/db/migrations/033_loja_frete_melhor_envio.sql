-- Frete por transportadora (Melhor Envio) na loja online: cada empresa conecta a PROPRIA conta do Melhor Envio (token
-- pessoal cifrado). O site cota pelo CEP (Correios, Jadlog, Azul...), o cliente escolhe o servico no checkout e, no
-- painel, a loja compra a etiqueta (saldo da conta dela), imprime e o rastreio entra sozinho no pedido.
ALTER TABLE lv_lojas ADD COLUMN me_token_cript TEXT;
ALTER TABLE lv_lojas ADD COLUMN me_sandbox BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lv_lojas ADD COLUMN me_conta TEXT;                 -- nome/e-mail da conta conferida ao conectar
ALTER TABLE lv_lojas ADD COLUMN me_conectado_em TIMESTAMPTZ;
ALTER TABLE lv_lojas ADD COLUMN envio_ativo BOOLEAN NOT NULL DEFAULT false;   -- oferece envio por transportadora no site
-- servicos oferecidos no site (ids do Melhor Envio: 1 = PAC, 2 = SEDEX...); vazio = todos os da conta
ALTER TABLE lv_lojas ADD COLUMN envio_servicos INTEGER[] NOT NULL DEFAULT '{}';
-- remetente / origem (vai na etiqueta): { nome, telefone, email, documento (CPF/CNPJ), cep, logradouro, numero, complemento, bairro, cidade, uf }
ALTER TABLE lv_lojas ADD COLUMN envio_remetente JSONB NOT NULL DEFAULT '{}';
ALTER TABLE lv_lojas ADD COLUMN envio_dias_extra INTEGER NOT NULL DEFAULT 1 CHECK (envio_dias_extra BETWEEN 0 AND 30);  -- prazo de separacao somado ao da transportadora
ALTER TABLE lv_lojas ADD COLUMN envio_acrescimo NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (envio_acrescimo >= 0);           -- somado ao frete (embalagem, manuseio)
ALTER TABLE lv_lojas ADD COLUMN envio_gratis_acima NUMERIC(12,2) CHECK (envio_gratis_acima IS NULL OR envio_gratis_acima > 0); -- frete gratis (servico mais barato) a partir de
ALTER TABLE lv_lojas ADD COLUMN envio_declaracao BOOLEAN NOT NULL DEFAULT true;  -- envia com declaracao de conteudo (sem NF-e)
-- embalagem/peso usados quando o produto nao tem os seus: { peso_kg, altura_cm, largura_cm, comprimento_cm }
ALTER TABLE lv_lojas ADD COLUMN envio_padrao JSONB NOT NULL DEFAULT '{"peso_kg": 0.3, "altura_cm": 4, "largura_cm": 12, "comprimento_cm": 16}';

ALTER TABLE lv_produtos ADD COLUMN peso_kg NUMERIC(8,3) CHECK (peso_kg IS NULL OR peso_kg > 0);
ALTER TABLE lv_produtos ADD COLUMN altura_cm NUMERIC(8,1) CHECK (altura_cm IS NULL OR altura_cm > 0);
ALTER TABLE lv_produtos ADD COLUMN largura_cm NUMERIC(8,1) CHECK (largura_cm IS NULL OR largura_cm > 0);
ALTER TABLE lv_produtos ADD COLUMN comprimento_cm NUMERIC(8,1) CHECK (comprimento_cm IS NULL OR comprimento_cm > 0);

-- Pedido enviado por transportadora: servico escolhido, prazo, cotacao e a etiqueta no Melhor Envio.
ALTER TABLE orders ADD COLUMN frete_servico_id INTEGER;
ALTER TABLE orders ADD COLUMN frete_servico_nome TEXT;          -- "Correios PAC"
ALTER TABLE orders ADD COLUMN frete_prazo_dias INTEGER;         -- prazo informado ao cliente (ja com os dias de separacao)
ALTER TABLE orders ADD COLUMN frete_custo NUMERIC(12,2);        -- valor cotado na transportadora (sem acrescimo/gratis)
ALTER TABLE orders ADD COLUMN frete_cep TEXT;
ALTER TABLE orders ADD COLUMN frete_volumes JSONB;              -- pacotes da cotacao (medidas e peso) usados na etiqueta
ALTER TABLE orders ADD COLUMN frete_destino JSONB;              -- destinatario da etiqueta (nome, telefone, e-mail, CPF, endereco em campos)
ALTER TABLE orders ADD COLUMN me_envio_id TEXT;                 -- id da etiqueta no Melhor Envio
ALTER TABLE orders ADD COLUMN me_status TEXT;                   -- pending | released | posted | delivered | canceled ...
ALTER TABLE orders ADD COLUMN me_etiqueta_em TIMESTAMPTZ;
CREATE INDEX idx_orders_me_envio ON orders(me_envio_id) WHERE me_envio_id IS NOT NULL;

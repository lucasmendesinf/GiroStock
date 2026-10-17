-- 99Food: os pedidos chegam por webhook (integracoes_delivery com plataforma '99food'; merchant_id = app_shop_id,
-- o codigo da loja que o GiroStock gera e a loja informa ao autorizar o app no portal da 99Food).
-- Na entrega feita pela loja, a 99Food pede o nome e o telefone do entregador (o cliente acompanha pelo app).
ALTER TABLE couriers ADD COLUMN telefone TEXT;

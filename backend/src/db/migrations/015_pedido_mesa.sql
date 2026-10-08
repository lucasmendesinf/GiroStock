-- Destino do pedido: alem de retirada e entrega, atendimento em mesa (o numero/nome da mesa fica em orders.endereco).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%retirada%'
  LOOP
    EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE orders ADD CONSTRAINT orders_tipo_check CHECK (tipo IN ('retirada', 'entrega', 'mesa'));

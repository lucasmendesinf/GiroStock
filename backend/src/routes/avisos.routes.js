// Avisos de pedido novo (cartao lateral + som em qualquer tela): pedidos que chegaram sozinhos e ainda nao foram aceitos.
// - iFood, 99Food e cardapio digital da loja virtual -> tela Pedidos (area Pedidos);
// - loja online (lv_fluxo 'ecommerce') -> Loja virtual > Pedidos do site (area LojaVirtual).
// Pedido pago no site so avisa depois do pagamento aprovado. Consulta leve, feita a cada ~10 s pelo navegador.
const express = require('express');
const pool = require('../db/pool');
const { filtroLocais } = require('../utils/access');

const router = express.Router();

router.get('/avisos/pedidos', async (req, res) => {
  const a = req.user.areas || {};
  const verPedidos = !!a.Pedidos;
  const verSite = !!a.LojaVirtual;
  if (!verPedidos && !verSite) return res.json({ pedidos: [] });
  const params = [req.user.tenantId];
  let where = `o.tenant_id = $1 AND o.status = 'novo' AND o.criado_em > now() - interval '12 hours'
    AND (o.origem <> 'loja_virtual' OR o.pagamento_online IS NULL OR o.pagamento_status = 'aprovado')`;
  const tipos = [];
  if (verPedidos) tipos.push(`(o.lv_fluxo IS DISTINCT FROM 'ecommerce' AND o.origem IN ('ifood', '99food', 'loja_virtual'))`);
  if (verSite) tipos.push(`o.lv_fluxo = 'ecommerce'`);
  where += ` AND (${tipos.join(' OR ')})`;
  const locais = filtroLocais(req.user, null);
  if (locais) {
    params.push(locais);
    where += ` AND o.location_id = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await pool.query(
    `SELECT o.id, o.numero, o.origem, o.codigo_externo, o.cliente_nome, o.tipo, o.criado_em, l.nome AS location_nome,
            (o.lv_fluxo IS NOT DISTINCT FROM 'ecommerce') AS do_site,
            COALESCE(SUM(oi.subtotal), 0) + o.taxa_entrega - o.desconto AS total, COALESCE(SUM(oi.quantidade), 0) AS itens
     FROM orders o JOIN locations l ON l.id = o.location_id LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE ${where} GROUP BY o.id, l.nome ORDER BY o.criado_em LIMIT 30`,
    params
  );
  res.json({ pedidos: rows.map((r) => ({ ...r, total: Number(r.total), itens: Number(r.itens) })) });
});

module.exports = router;

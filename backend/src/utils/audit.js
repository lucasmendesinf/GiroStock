async function logAudit(client, { tenantId, usuarioId, acao, recurso, recursoId, detalhes }) {
  await client.query(
    `INSERT INTO audit_logs (tenant_id, usuario_id, acao, recurso, recurso_id, detalhes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, usuarioId || null, acao, recurso, recursoId || null, detalhes ? JSON.stringify(detalhes) : null]
  );
}

module.exports = { logAudit };

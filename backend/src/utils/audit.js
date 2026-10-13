const contextoSuporte = require('./contextoSuporte');

async function logAudit(client, { tenantId, usuarioId, acao, recurso, recursoId, detalhes }) {
  // Durante o suporte do Master, todo registro leva a marca (o autor continua sendo o Master, nunca o administrador real).
  const sup = contextoSuporte.atual();
  const final = sup ? { ...(detalhes || {}), suporte: true, sessao_suporte_id: sup.sessaoId, master_id: sup.masterId } : detalhes;
  await client.query(
    `INSERT INTO audit_logs (tenant_id, usuario_id, acao, recurso, recurso_id, detalhes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, usuarioId || null, acao, recurso, recursoId || null, final ? JSON.stringify(final) : null]
  );
}

module.exports = { logAudit };

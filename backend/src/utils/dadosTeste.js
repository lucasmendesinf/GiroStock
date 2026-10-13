// Dados criados pelos testes automatizados (e2e): empresas "E2E ..." e usuarios e2e.*@girostock.local / ui2fa@teste.local.
// O painel Master os OCULTA por padrao (listas, resumos, uso e auditoria); `?teste=1` mostra tudo (os proprios e2e usam isso).
const mostrarTeste = (req) => String((req.query || {}).teste) === '1';

// Condicao SQL "NAO e dado de teste" para a empresa (alias de tenants) e/ou usuario (alias de users). Aceita alias ausente.
function semDadosDeTeste({ empresa, usuario }) {
  const c = [];
  if (empresa) c.push(`COALESCE(${empresa}.nome, '') NOT LIKE 'E2E %'`);
  if (usuario) c.push(`COALESCE(lower(${usuario}.email::text), '') NOT LIKE 'e2e.%@girostock.local'`, `COALESCE(lower(${usuario}.email::text), '') <> 'ui2fa@teste.local'`);
  return c.join(' AND ');
}

module.exports = { mostrarTeste, semDadosDeTeste };

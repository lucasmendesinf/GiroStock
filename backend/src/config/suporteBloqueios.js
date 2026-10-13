// O que uma sessao de suporte (Master atuando como Administrador de uma empresa) pode ou nao fazer.
// UM arquivo, facil de revisar. Os caminhos sao comparados SEM o prefixo /api e sem query string.
// Regras, nesta ordem:
//  1. LIBERADAS: sempre passam (encerrar o proprio suporte).
//  2. BLOQUEADAS_SEMPRE: valem mesmo com "Permitir edicao" ligado.
//  3. Leitura (GET/HEAD/OPTIONS): passa.
//  4. Escrita sem "Permitir edicao": 403 (somente leitura).
//  5. Escrita com edicao: DELETE nunca; so os cadastros da lista EDICAO_PERMITIDA (produtos, categorias, fornecedores,
//     lojas, PDVs, insumos e estoque). Tudo o mais (vendas, caixa, pedidos, clientes, usuarios...) fica bloqueado.
const LEITURA = ['GET', 'HEAD', 'OPTIONS'];

const LIBERADAS = [
  { metodo: 'POST', re: /^\/master\/suporte\/encerrar$/ },
];

const BLOQUEADAS_SEMPRE = [
  { metodos: '*', re: /^\/master(\/|$)/, motivo: 'O painel Master não está disponível durante o suporte.' },
  { metodos: 'escrita', re: /^\/users(\/|$)/, motivo: 'Usuários, senhas, permissões e 2FA não podem ser alterados em sessão de suporte.' },
  { metodos: 'escrita', re: /^\/auth\/(change-password|modo-teste|2fa)(\/|$)/, motivo: 'Senha, 2FA e modo teste não podem ser alterados em sessão de suporte.' },
  { metodos: 'escrita', re: /^\/(sales|orders)\/[^/]+\/cancel$/, motivo: 'Cancelamentos (estornam estoque e caixa) não são permitidos em sessão de suporte.' },
];

const EDICAO_PERMITIDA = [
  /^\/(products|categories|suppliers|locations|terminals|ingredients)(\/|$)/,
  /^\/(stock-entries|stock-movements|purchase-notes)(\/|$)/,
];

function ehEscrita(metodo) { return !LEITURA.includes(metodo); }

// Devolve a mensagem de bloqueio (string) ou null se a requisicao pode seguir.
function verificar(metodo, caminho, edicao) {
  if (LIBERADAS.some((r) => r.metodo === metodo && r.re.test(caminho))) return null;
  for (const r of BLOQUEADAS_SEMPRE) {
    if ((r.metodos === '*' || (r.metodos === 'escrita' && ehEscrita(metodo))) && r.re.test(caminho)) return r.motivo;
  }
  if (!ehEscrita(metodo)) return null;
  if (!edicao) return 'Sessão de suporte somente leitura.';
  if (metodo === 'DELETE') return 'Exclusões não são permitidas em sessão de suporte.';
  if (!EDICAO_PERMITIDA.some((re) => re.test(caminho))) return 'Esta ação não é permitida em sessão de suporte.';
  return null;
}

module.exports = { verificar, DURACAO_MIN: 30, LIBERADAS, BLOQUEADAS_SEMPRE, EDICAO_PERMITIDA };

// Apoio do painel Master.
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789'; // sem caracteres ambiguos (i, l, o, 0, 1)

// Senha temporaria legivel (10 caracteres), gerada no navegador com a API criptografica.
export function gerarSenha(tamanho = 10) {
  const bytes = new Uint32Array(tamanho);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALFABETO[b % ALFABETO.length]).join('');
}

export async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); return true; } catch { return false; }
}

export const NOME_PERFIL = ['Administrador', 'Gerente', 'Caixa/Operador', 'Estoque', 'Lanchonete/Cozinha', 'Financeiro'];

export function quando(v) {
  if (!v) return 'nunca';
  const d = new Date(v);
  const dias = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (dias <= 0) return 'hoje ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (dias === 1) return 'ontem';
  return `há ${dias} dias`;
}

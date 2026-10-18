export const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const qtd = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
export const dataHora = (v) => (v ? new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
export const soDigitos = (v) => String(v || '').replace(/\D/g, '');
export function fmtTel(v) {
  const d = soDigitos(v);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return v || '';
}
export function parseValor(t) {
  const s = String(t || '').trim().replace(/[R$\s]/g, '');
  if (!s) return null;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? n : null;
}
export const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

// Chave de um item no carrinho: o mesmo produto com outros complementos/observacao e outra linha.
export const chaveItem = (i) => `${i.product_id}|${(i.complementos || []).map((c) => `${c.id}x${c.quantidade}`).sort().join(',')}|${i.observacao || ''}`;

// Cor do texto que fica legivel sobre uma cor de fundo (#RRGGBB).
export function corSobre(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return '#fff';
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#111' : '#fff';
}

// Mistura uma cor com branco/preto (0..1) para fundos suaves derivados da cor da loja.
export function misturar(hex, alvo, peso) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return hex;
  const t = alvo === 'preto' ? 0 : 255;
  return `#${m.slice(1).map((x) => Math.round(parseInt(x, 16) * (1 - peso) + t * peso).toString(16).padStart(2, '0')).join('')}`;
}

const FONTES = {
  moderna: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  classica: 'Georgia, "Times New Roman", serif',
  arredondada: '"Trebuchet MS", "Nunito", "Varela Round", system-ui, sans-serif',
};

// Tema da loja -> variaveis CSS no documento.
export function aplicarTema(tema, nome) {
  const r = document.documentElement.style;
  r.setProperty('--primaria', tema.cor_primaria);
  r.setProperty('--sobre-primaria', corSobre(tema.cor_primaria));
  r.setProperty('--primaria-suave', misturar(tema.cor_primaria, 'branco', 0.9));
  r.setProperty('--fundo', tema.cor_fundo);
  r.setProperty('--texto', tema.cor_texto);
  r.setProperty('--destaque', tema.cor_destaque);
  r.setProperty('--sobre-destaque', corSobre(tema.cor_destaque));
  r.setProperty('--linha', misturar(tema.cor_texto, 'branco', 0.86));
  r.setProperty('--painel', misturar(tema.cor_fundo, 'preto', 0.03));
  r.setProperty('--suave', misturar(tema.cor_texto, 'branco', 0.42));
  r.setProperty('--fonte', FONTES[tema.fonte] || FONTES.moderna);
  r.setProperty('--raio', tema.cantos === 'retos' ? '2px' : '14px');
  document.body.className = `modelo-${tema.modelo}`;
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', tema.cor_primaria);
  if (nome) document.title = nome;
}

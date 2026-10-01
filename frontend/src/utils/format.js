// Formatacao no padrao brasileiro (R$ 1.234,56 / 1.234,5 kg / 01/10/2026 14:30).

const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const decimal3 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const decimal4 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const inteiro = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

export const UNIDADES_INTEIRAS = ['UN', 'CX'];

export function brl(valor) {
  const n = Number(valor);
  return moeda.format(Number.isFinite(n) ? n : 0);
}

// Custo por unidade de insumo (ex: R$ 0,0350/g) precisa de mais casas.
export function brlFino(valor) {
  const n = Number(valor);
  return `R$ ${decimal4.format(Number.isFinite(n) ? n : 0)}`;
}

// Quantidade: inteira para UN/CX, ate 3 casas para KG/L/G etc. "53.000" vira "53".
export function qtd(valor, unidade) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return '0';
  return UNIDADES_INTEIRAS.includes(unidade) ? inteiro.format(n) : decimal3.format(n);
}

export function qtdComUnidade(valor, unidade) {
  return `${qtd(valor, unidade)} ${unidade || ''}`.trim();
}

export function pct(valor) {
  const n = Number(valor);
  return `${decimal3.format(Number.isFinite(n) ? n : 0)}%`;
}

export function dataHora(valor) {
  if (!valor) return '';
  return new Date(valor).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function data(valor) {
  if (!valor) return '';
  return new Date(valor).toLocaleDateString('pt-BR');
}

// Aceita "0,350", "1.234,50", "12.5" e devolve numero (NaN se invalido).
export function parseNumero(texto) {
  if (typeof texto === 'number') return texto;
  let t = String(texto || '').trim().replace(/\s/g, '').replace(/^R\$/, '');
  if (t === '') return NaN;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return Number(t);
}

// Data local no formato AAAA-MM-DD (para filtros de periodo).
export function isoLocal(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export const FORMA_PAGAMENTO = {
  pix: 'Pix',
  cartao_credito: 'Cartão de crédito',
  cartao_debito: 'Cartão de débito',
  dinheiro: 'Dinheiro',
};

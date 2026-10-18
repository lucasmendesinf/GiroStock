import { useState } from 'react';
import { brl } from '../../utils/format';

// Datas do financeiro chegam como texto AAAA-MM-DD (sem fuso): mostrar sem passar por Date (evita "um dia antes").
export const diaBR = (d) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');
export const diaCurto = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const mesBR = (m) => (m ? `${MESES[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}` : '');
export const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// "Hoje" vem do servidor (fuso de Sao Paulo), nao do relogio do aparelho: o Financeiro guarda o valor ao abrir.
let hojeDoServidor = null;
export function definirHoje(d) { hojeDoServidor = d; }
export function hojeISO() {
  if (hojeDoServidor) return hojeDoServidor;
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
export function maisDias(iso, n) {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
export function maisMeses(iso, n) {
  const [a, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export const SITUACAO = {
  aberto: ['', 'Em aberto'], vencido: ['err', 'Vencido'], pago: ['ok', 'Pago'], cancelado: ['', 'Cancelado'],
};
export function Situacao({ t }) {
  const [cls, txt] = SITUACAO[t.situacao] || ['', t.situacao];
  const rotulo = t.situacao === 'pago' ? (t.tipo === 'receber' ? 'Recebido' : 'Pago') : txt;
  return <span className={`ped-pill ${cls}`}>{rotulo}</span>;
}

// Quando vence, em palavras: "vence hoje", "venceu há 3 dias", "em 5 dias".
export function quandoVence(t) {
  if (t.situacao === 'pago') return t.pago_em ? `${t.tipo === 'receber' ? 'recebido' : 'pago'} em ${diaBR(t.pago_em)}` : '';
  if (t.situacao === 'cancelado') return 'cancelado';
  const n = Number(t.dias_para_vencer);
  if (n === 0) return 'vence hoje';
  if (n < 0) return `venceu há ${-n} dia${n === -1 ? '' : 's'}`;
  if (n === 1) return 'vence amanhã';
  return `em ${n} dias`;
}

export const FORMAS_BAIXA = [
  ['pix', 'Pix'], ['boleto', 'Boleto'], ['transferencia', 'Transferência'], ['dinheiro', 'Dinheiro'],
  ['cartao_debito', 'Cartão de débito'], ['cartao_credito', 'Cartão de crédito'], ['cheque', 'Cheque'], ['outro', 'Outro'],
];

// Barras de uma serie so (sem legenda: o titulo diz o que e). Valor positivo na cor do sistema, negativo em vermelho
// (polaridade). Passar o mouse/dedo mostra o valor; a tabela da tela tem os mesmos numeros.
export function Barras({ dados, altura = 140, rotulo, titulo, destaque }) {
  const [ativo, setAtivo] = useState(null);
  if (!dados || dados.length === 0) return null;
  const max = Math.max(...dados.map((d) => Math.abs(d.valor)), 1);
  const temNeg = dados.some((d) => d.valor < 0);
  const temPos = dados.some((d) => d.valor > 0);
  // com negativos, a linha do zero fica no meio proporcional
  const maxPos = Math.max(...dados.map((d) => d.valor), 0);
  const maxNeg = Math.max(...dados.map((d) => -d.valor), 0);
  const zero = temNeg ? (temPos ? maxPos / (maxPos + maxNeg) : 0) : 1;
  const escala = temNeg && temPos ? maxPos + maxNeg : max;
  const sel = ativo !== null ? dados[ativo] : null;
  return (
    <figure className="fin-barras" aria-label={titulo}>
      <div className="fin-barras-dica" aria-live="polite">{sel ? <><b>{rotulo(sel)}</b> {brl(sel.valor)}</> : <span className="muted">Toque numa barra para ver o valor</span>}</div>
      <div className="fin-barras-area" style={{ height: altura }} onMouseLeave={() => setAtivo(null)}>
        <div className="fin-barras-zero" style={{ top: `${zero * 100}%` }} />
        {dados.map((d, i) => {
          const h = (Math.abs(d.valor) / escala) * 100;
          const neg = d.valor < 0;
          return (
            <button type="button" key={d.chave} className={`fin-barra ${ativo === i ? 'on' : ''} ${destaque && destaque(d) ? 'destaque' : ''}`}
              aria-label={`${rotulo(d)}: ${brl(d.valor)}`} onMouseEnter={() => setAtivo(i)} onFocus={() => setAtivo(i)} onClick={() => setAtivo(i)}>
              <span className={`fin-barra-marca ${neg ? 'neg' : ''}`}
                style={neg ? { top: `${zero * 100}%`, height: `${h}%` } : { bottom: `${(1 - zero) * 100}%`, height: `${Math.max(h, d.valor ? 1.5 : 0)}%` }} />
            </button>
          );
        })}
      </div>
      <div className="fin-barras-eixo"><span>{rotulo(dados[0])}</span><span>{rotulo(dados[dados.length - 1])}</span></div>
    </figure>
  );
}

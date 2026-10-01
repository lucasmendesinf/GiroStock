import { brl, dataHora, qtd, FORMA_PAGAMENTO } from '../utils/format';

// Cupom nao fiscal: so aparece na impressao (ver @media print no CSS).
export default function Cupom({ venda }) {
  return (
    <div className="cupom-print" aria-hidden="true">
      <div className="cupom-centro">
        <strong>{venda.empresa_nome}</strong>
        <div>{venda.location_nome}</div>
        <div>CUPOM NÃO FISCAL</div>
      </div>
      <div className="cupom-linha" />
      <div>Venda nº {venda.numero} · {dataHora(venda.criado_em)}</div>
      <div>{venda.terminal_nome} · Operador: {venda.operador_nome}</div>
      <div className="cupom-linha" />
      {venda.itens.map((i) => (
        <div key={i.id} className="cupom-item">
          <div>{i.product_nome}</div>
          <div className="cupom-dir">{qtd(i.quantidade, i.unidade)} {i.unidade} x {brl(i.preco_unitario)} = {brl(i.subtotal)}</div>
        </div>
      ))}
      <div className="cupom-linha" />
      <div className="cupom-dir">Subtotal {brl(venda.subtotal)}</div>
      {Number(venda.desconto) > 0 && <div className="cupom-dir">Desconto − {brl(venda.desconto)}</div>}
      <div className="cupom-dir cupom-total">TOTAL {brl(venda.total)}</div>
      <div className="cupom-dir">{FORMA_PAGAMENTO[venda.forma_pagamento]}</div>
      {venda.troco !== null && <div className="cupom-dir">Recebido {brl(venda.valor_recebido)} · Troco {brl(venda.troco)}</div>}
      {venda.status === 'cancelada' && <div className="cupom-centro"><strong>VENDA CANCELADA</strong></div>}
      <div className="cupom-linha" />
      <div className="cupom-centro">Obrigado pela preferência!</div>
    </div>
  );
}

// Renderiza o cupom e abre a janela de impressao do navegador.
export function imprimirCupom(setCupom, venda) {
  setCupom(venda);
  setTimeout(() => window.print(), 150);
}

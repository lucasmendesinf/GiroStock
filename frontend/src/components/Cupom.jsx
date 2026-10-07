import { brl, dataHora, qtd, FORMA_PAGAMENTO } from '../utils/format';

// Padrao da configuracao (igual ao do backend: backend/src/utils/cupom.js).
export const CONFIG_PADRAO = {
  cliente: {
    largura_mm: 80, cabecalho: '', rodape: 'Obrigado pela preferência!',
    mostrar_empresa: true, mostrar_loja: true, mostrar_data: true, mostrar_numero_venda: true, mostrar_terminal: true,
    mostrar_operador: true, mostrar_codigo_produto: false, mostrar_observacao: true, mostrar_desconto: true, mostrar_forma_pagamento: true, mostrar_troco: true,
    tamanho_pedido: 'grande', vias: 1, imprimir_automatico: false,
  },
  cozinha: {
    ativo: false, largura_mm: 80, cabecalho: 'COMANDA DA COZINHA', itens: 'preparo',
    mostrar_loja: true, mostrar_data: true, mostrar_operador: false, mostrar_valores: false, tamanho_pedido: 'grande', imprimir_automatico: false,
  },
};

export function configDaVenda(venda) {
  const c = (venda && venda.cupom_config) || {};
  return { cliente: { ...CONFIG_PADRAO.cliente, ...(c.cliente || {}) }, cozinha: { ...CONFIG_PADRAO.cozinha, ...(c.cozinha || {}) } };
}

function Pedido({ numero, tamanho }) {
  if (numero === null || numero === undefined) return null;
  return (
    <div className={`cupom-pedido cupom-pedido-${tamanho}`}>
      <div className="cupom-pedido-rotulo">PEDIDO</div>
      <div className="cupom-pedido-numero">Nº {numero}</div>
    </div>
  );
}

// Cupom do cliente (nao fiscal), conforme a configuracao da loja.
export function CupomCliente({ venda, config }) {
  const c = config.cliente;
  return (
    <div className="cupom-doc" style={{ width: `${c.largura_mm === 58 ? 52 : 72}mm` }}>
      <div className="cupom-centro">
        {c.mostrar_empresa && <strong>{venda.empresa_nome}</strong>}
        {c.mostrar_loja && <div>{venda.location_nome}</div>}
        {c.cabecalho && <div className="cupom-texto">{c.cabecalho}</div>}
        <div>CUPOM NÃO FISCAL</div>
      </div>
      <Pedido numero={venda.numero_pedido} tamanho={c.tamanho_pedido} />
      <div className="cupom-linha" />
      {(c.mostrar_numero_venda || c.mostrar_data) && (
        <div>{c.mostrar_numero_venda ? `Venda nº ${venda.numero}` : ''}{c.mostrar_numero_venda && c.mostrar_data ? ' · ' : ''}{c.mostrar_data ? dataHora(venda.criado_em) : ''}</div>
      )}
      {(c.mostrar_terminal || c.mostrar_operador) && (
        <div>{c.mostrar_terminal ? venda.terminal_nome : ''}{c.mostrar_terminal && c.mostrar_operador ? ' · ' : ''}{c.mostrar_operador ? `Operador: ${venda.operador_nome}` : ''}</div>
      )}
      <div className="cupom-linha" />
      {venda.itens.map((i) => (
        <div key={i.id} className="cupom-item">
          <div>{c.mostrar_codigo_produto && i.codigo_interno ? `${i.codigo_interno} ` : ''}{i.product_nome}</div>
          <div className="cupom-dir">{qtd(i.quantidade, i.unidade)} {i.unidade} x {brl(i.preco_unitario)} = {brl(i.subtotal)}</div>
          {c.mostrar_observacao && i.observacao && <div className="cupom-obs">Obs: {i.observacao}</div>}
        </div>
      ))}
      <div className="cupom-linha" />
      <div className="cupom-dir">Subtotal {brl(venda.subtotal)}</div>
      {c.mostrar_desconto && Number(venda.desconto) > 0 && <div className="cupom-dir">Desconto − {brl(venda.desconto)}</div>}
      <div className="cupom-dir cupom-total">TOTAL {brl(venda.total)}</div>
      {c.mostrar_forma_pagamento && <div className="cupom-dir">{FORMA_PAGAMENTO[venda.forma_pagamento]}</div>}
      {c.mostrar_troco && venda.troco !== null && venda.troco !== undefined && <div className="cupom-dir">Recebido {brl(venda.valor_recebido)} · Troco {brl(venda.troco)}</div>}
      {venda.status === 'cancelada' && <div className="cupom-centro"><strong>VENDA CANCELADA</strong></div>}
      {c.rodape && (<><div className="cupom-linha" /><div className="cupom-centro cupom-texto">{c.rodape}</div></>)}
    </div>
  );
}

// Comanda da cozinha: so o que precisa ser preparado, com o numero do pedido em destaque.
export function ComandaCozinha({ venda, config }) {
  const k = config.cozinha;
  const itens = k.itens === 'todos' ? venda.itens : venda.itens.filter((i) => i.preparo);
  return (
    <div className="cupom-doc" style={{ width: `${k.largura_mm === 58 ? 52 : 72}mm` }}>
      <div className="cupom-centro">
        {k.cabecalho && <strong className="cupom-texto">{k.cabecalho}</strong>}
        {k.mostrar_loja && <div>{venda.location_nome}</div>}
      </div>
      <Pedido numero={venda.numero_pedido} tamanho={k.tamanho_pedido} />
      {venda.numero_pedido === null || venda.numero_pedido === undefined ? <div className="cupom-centro">Venda nº {venda.numero}</div> : null}
      {k.mostrar_data && <div className="cupom-centro">{dataHora(venda.criado_em)}</div>}
      {k.mostrar_operador && <div className="cupom-centro">Operador: {venda.operador_nome}</div>}
      <div className="cupom-linha" />
      {itens.length === 0 && <div className="cupom-centro">Sem itens para preparar</div>}
      {itens.map((i) => (
        <div key={i.id} className="cupom-item cupom-item-cozinha">
          <strong>{qtd(i.quantidade, i.unidade)}{i.unidade && i.unidade !== 'UN' ? ` ${i.unidade}` : 'x'}</strong> {i.product_nome}
          {k.mostrar_valores && <span className="cupom-dir"> {brl(i.subtotal)}</span>}
          {i.observacao && <div className="cupom-obs cupom-obs-cozinha">» {i.observacao}</div>}
        </div>
      ))}
      <div className="cupom-linha" />
    </div>
  );
}

// Area de impressao (so aparece no print). modo: 'cliente' | 'cozinha' | 'ambos'.
export default function Cupom({ venda }) {
  const config = configDaVenda(venda);
  const modo = venda.modo || 'cliente';
  const vias = Math.max(1, Number(config.cliente.vias) || 1);
  const docs = [];
  if (modo === 'cliente' || modo === 'ambos') for (let v = 0; v < vias; v += 1) docs.push(<CupomCliente key={`c${v}`} venda={venda} config={config} />);
  if (modo === 'cozinha' || modo === 'ambos') docs.push(<ComandaCozinha key="k" venda={venda} config={config} />);
  const largura = (modo === 'cozinha' ? config.cozinha.largura_mm : config.cliente.largura_mm) === 58 ? 58 : 80;
  return (
    <div className="cupom-print" aria-hidden="true">
      <style>{`@media print { @page { size: ${largura}mm auto; margin: 0; } }`}</style>
      {docs}
    </div>
  );
}

// Renderiza o cupom e abre a janela de impressao do navegador.
// Para impressora termica, basta escolhe-la na janela (80 mm ou 58 mm conforme a configuracao da loja).
export function imprimirCupom(setCupom, venda, modo = 'cliente') {
  setCupom({ ...venda, modo });
  setTimeout(() => window.print(), 150);
}

// Impressao automatica configurada na loja: devolve 'cliente', 'cozinha', 'ambos' ou null.
export function modoAutomatico(venda) {
  const c = configDaVenda(venda);
  const cliente = !!c.cliente.imprimir_automatico;
  const cozinha = !!(c.cozinha.ativo && c.cozinha.imprimir_automatico);
  if (cliente && cozinha) return 'ambos';
  if (cliente) return 'cliente';
  if (cozinha) return 'cozinha';
  return null;
}

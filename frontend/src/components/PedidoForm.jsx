import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Modal } from './ui.jsx';
import { brl, parseNumero, qtd } from '../utils/format';

export const ORIGENS = [
  { id: 'balcao', nome: 'Balcão' },
  { id: 'telefone', nome: 'Telefone' },
  { id: 'whatsapp', nome: 'WhatsApp' },
];
export const NOME_ORIGEM = { balcao: 'Balcão', telefone: 'Telefone', whatsapp: 'WhatsApp', ifood: 'iFood', '99food': '99Food' };

// Pedido -> objeto no formato que o cupom/comanda ja sabe imprimir.
export function vendaDoPedido(p) {
  return {
    ...p,
    numero_pedido: p.numero,
    operador_nome: p.criado_por_nome || '',
    terminal_nome: '',
    itens: p.itens.map((i) => ({ ...i, unidade: i.unidade || 'UN' })),
    pedido: { origem: NOME_ORIGEM[p.origem] || p.origem, tipo: p.tipo, cliente: p.cliente_nome, telefone: p.cliente_telefone, endereco: p.endereco, observacao: p.observacao },
  };
}

const PAGAMENTOS = [
  { id: 'dinheiro', nome: 'Pagar na retirada/entrega (dinheiro)', forma: 'dinheiro', pago: false },
  { id: 'cartao', nome: 'Pagar na retirada/entrega (cartão)', forma: 'cartao', pago: false },
  { id: 'pix', nome: 'Pix (já pago)', forma: 'pix', pago: true },
];

// Modal "Gerar pedido" / "Novo pedido": dados do cliente, retirada ou entrega, pagamento e itens.
// No PDV os itens vem do carrinho (permitirBusca = false); na tela Pedidos o operador busca os produtos.
export default function PedidoForm({ lojaId, origemInicial = 'balcao', itensIniciais = [], permitirBusca = false, mostrarOrigem = false, titulo = 'Gerar pedido', onClose, onCriado }) {
  const toast = useToast();
  const [origem, setOrigem] = useState(origemInicial);
  const [cliente, setCliente] = useState('');
  const [telefone, setTelefone] = useState('');
  const [tipo, setTipo] = useState('retirada');
  const [endereco, setEndereco] = useState('');
  const [taxaTxt, setTaxaTxt] = useState('5,00');
  const [pagamento, setPagamento] = useState('dinheiro');
  const [observacao, setObservacao] = useState('');
  const [itens, setItens] = useState(itensIniciais);
  const [busca, setBusca] = useState('');
  const [achados, setAchados] = useState([]);
  const [salvando, setSalvando] = useState(false);
  const timer = useRef(null);

  const taxa = tipo === 'entrega' ? Math.max(0, parseNumero(taxaTxt) || 0) : 0;
  const subtotal = itens.reduce((s, i) => s + i.preco * i.quantidade, 0);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!permitirBusca || busca.trim().length < 2) { setAchados([]); return undefined; }
    timer.current = setTimeout(async () => {
      try {
        setAchados(await api.get(`/products/search?q=${encodeURIComponent(busca.trim())}&location_id=${lojaId}&limit=8`));
      } catch (err) { toast.erro(err); }
    }, 200);
    return () => clearTimeout(timer.current);
  }, [busca, lojaId, permitirBusca, toast]);

  function adicionar(p) {
    const disponivel = Number(p.saldo);
    const existente = itens.find((i) => i.product_id === p.id);
    if ((existente ? existente.quantidade : 0) + 1 > disponivel) { toast.erro(`Sem estoque disponível de ${p.nome}`); return; }
    if (existente) setItens(itens.map((i) => (i.product_id === p.id ? { ...i, quantidade: i.quantidade + 1 } : i)));
    else setItens([...itens, { product_id: p.id, nome: p.nome, unidade: p.unidade, preco: Number(p.preco_venda), quantidade: 1, observacao: '', tem_ficha: !!p.tem_ficha_tecnica, limite: disponivel }]);
    setBusca('');
    setAchados([]);
  }

  function mudarQtd(id, delta) {
    setItens((atual) => atual.flatMap((i) => {
      if (i.product_id !== id) return [i];
      const nova = i.quantidade + delta;
      if (nova < 1) return [];
      if (delta > 0 && i.limite !== undefined && nova > i.limite) { toast.erro(`Sem estoque disponível de ${i.nome}`); return [i]; }
      return [{ ...i, quantidade: nova }];
    }));
  }

  async function criar() {
    if (itens.length === 0) { toast.erro('Adicione ao menos um item.'); return; }
    if (tipo === 'entrega' && endereco.trim().length < 3) { toast.erro('Informe o endereço da entrega.'); return; }
    const pag = PAGAMENTOS.find((p) => p.id === pagamento);
    setSalvando(true);
    try {
      const pedido = await api.post('/orders', {
        location_id: lojaId, origem, cliente_nome: cliente, cliente_telefone: telefone, tipo, endereco, taxa_entrega: taxa,
        observacao, forma_pagamento_prevista: pag.forma, pago: pag.pago,
        itens: itens.map((i) => ({ product_id: i.product_id, quantidade: i.quantidade, observacao: i.observacao || '' })),
      });
      onCriado(pedido);
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }

  return (
    <Modal titulo={<>{titulo} <span className="ped-tag">{NOME_ORIGEM[origem]}</span></>} onClose={onClose} largura="larga">
      <div className="form-stack">
        <div className="form-grid">
          {mostrarOrigem && (
            <label className="field"><span className="field-label">Origem</span>
              <select value={origem} onChange={(e) => setOrigem(e.target.value)}>{ORIGENS.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}</select>
            </label>
          )}
          <label className="field"><span className="field-label">Nome do cliente</span><input value={cliente} onChange={(e) => setCliente(e.target.value)} placeholder="Nome" autoFocus /></label>
          <label className="field"><span className="field-label">Telefone</span><input value={telefone} onChange={(e) => setTelefone(e.target.value)} placeholder="(00) 00000-0000" inputMode="tel" /></label>
        </div>

        <div className="field"><span className="field-label">Tipo</span>
          <div className="ped-seg2">
            <button type="button" className={tipo === 'retirada' ? 'on' : ''} onClick={() => setTipo('retirada')}>🛍 Retirada</button>
            <button type="button" className={tipo === 'entrega' ? 'on' : ''} onClick={() => setTipo('entrega')}>🛵 Entrega</button>
          </div>
        </div>
        {tipo === 'entrega' && (
          <div className="form-grid">
            <label className="field"><span className="field-label">Endereço</span><input value={endereco} onChange={(e) => setEndereco(e.target.value)} placeholder="Rua, nº, bairro" /></label>
            <label className="field" style={{ flex: '0 0 190px' }}><span>Taxa de entrega (R$)</span><input value={taxaTxt} onChange={(e) => setTaxaTxt(e.target.value)} inputMode="decimal" /></label>
          </div>
        )}

        <label className="field"><span className="field-label">Pagamento</span>
          <select value={pagamento} onChange={(e) => setPagamento(e.target.value)}>{PAGAMENTOS.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}</select>
        </label>

        <div className="ped-sec">
          <span className="ped-rotulo">Itens (estoque reservado ao confirmar)</span>
          {permitirBusca && (
            <div className="ped-busca">
              <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nome ou código…" />
              {achados.length > 0 && (
                <div className="ped-res">
                  {achados.map((p) => {
                    const d = Number(p.saldo);
                    return (
                      <button type="button" key={p.id} disabled={d <= 0} onClick={() => adicionar(p)}>
                        <span>{p.nome} <small>· disponível {qtd(d, p.unidade)}</small></span>
                        <b>{brl(p.preco_venda)}</b>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {itens.length === 0 && <div className="ped-vazio">Nenhum item</div>}
          {itens.map((i, idx) => (
            <div key={`${i.product_id}-${idx}`} className="ped-item">
              <div className="ped-item-linha">
                <span className="ped-item-nome">{i.nome}</span>
                {permitirBusca ? (
                  <span className="ped-qtd">
                    <button type="button" onClick={() => mudarQtd(i.product_id, -1)}>−</button>
                    <b>{i.quantidade}</b>
                    <button type="button" onClick={() => mudarQtd(i.product_id, 1)}>+</button>
                  </span>
                ) : <span>{qtd(i.quantidade, i.unidade)}× {brl(i.preco)}</span>}
                <span className="ped-item-valor">{brl(i.preco * i.quantidade)}</span>
              </div>
              {permitirBusca && i.tem_ficha && (
                <input className="ped-item-obs" maxLength={200} value={i.observacao || ''} placeholder="Observação (ex.: sem milho)"
                  onChange={(e) => setItens(itens.map((x) => (x.product_id === i.product_id ? { ...x, observacao: e.target.value } : x)))} />
              )}
              {!permitirBusca && i.observacao && <div className="ped-item-obsv">Obs.: {i.observacao}</div>}
            </div>
          ))}
          <label className="field"><span className="field-label">Observação do pedido</span>
            <textarea rows={2} maxLength={300} value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Ex.: troco para R$ 50, vem buscar às 20h" />
          </label>
          {taxa > 0 && <div className="ped-linha"><span>Taxa de entrega</span><span>{brl(taxa)}</span></div>}
          <div className="ped-linha ped-total"><span>Total</span><b>{brl(subtotal + taxa)}</b></div>
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Voltar</button>
          <button type="button" disabled={salvando || itens.length === 0} onClick={criar}>{salvando ? 'Gerando...' : 'Gerar pedido'}</button>
        </div>
      </div>
    </Modal>
  );
}

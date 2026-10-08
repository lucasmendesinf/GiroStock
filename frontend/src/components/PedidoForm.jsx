import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Modal } from './ui.jsx';
import ClienteTelefone from './ClienteTelefone.jsx';
import { brl, parseNumero, qtd } from '../utils/format';

const LOTE = 30;

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
  { id: 'dinheiro', nome: 'Pagar Dinheiro', forma: 'dinheiro' },
  { id: 'cartao_debito', nome: 'Pagar Cartão-Débito', forma: 'cartao_debito' },
  { id: 'cartao_credito', nome: 'Pagar Cartão-Crédito', forma: 'cartao_credito' },
  { id: 'pix', nome: 'Pagar no Pix', forma: 'pix' },
];

// Modal "Gerar pedido" / "Novo pedido": dados do cliente, retirada ou entrega, pagamento e itens.
// No PDV os itens vem do carrinho (permitirBusca = false); na tela Pedidos o operador busca os produtos.
export default function PedidoForm({ lojaId, origemInicial = 'balcao', itensIniciais = [], permitirBusca = false, mostrarOrigem = false, titulo = 'Gerar pedido', telefoneInicial = '', nomeInicial = '', tipoInicial = 'retirada', enderecoInicial = '', taxaInicial = '5,00', mesaInicial = '', cadastrarInicial = true, onClose, onCriado }) {
  const toast = useToast();
  const [origem, setOrigem] = useState(origemInicial);
  const [cliente, setCliente] = useState(nomeInicial);
  const [telefone, setTelefone] = useState(telefoneInicial);
  const [cadastrado, setCadastrado] = useState(null);
  const [cadastrar, setCadastrar] = useState(cadastrarInicial);
  const [tipo, setTipo] = useState(tipoInicial);
  const [endereco, setEndereco] = useState(enderecoInicial);
  const [mesa, setMesa] = useState(mesaInicial);
  const [taxaTxt, setTaxaTxt] = useState(taxaInicial);
  const [pagamento, setPagamento] = useState('dinheiro');
  const [jaPago, setJaPago] = useState(false);
  const [recebidoTxt, setRecebidoTxt] = useState('');
  const [observacao, setObservacao] = useState('');
  const [itens, setItens] = useState(itensIniciais);
  const [busca, setBusca] = useState('');
  const [achados, setAchados] = useState([]);
  const [temMais, setTemMais] = useState(false);
  const [sel, setSel] = useState(0);
  const [carregandoMais, setCarregandoMais] = useState(false);
  const listaRef = useRef(null);
  const [salvando, setSalvando] = useState(false);
  const timer = useRef(null);

  // Cliente cadastrado: nome e endereco padrao entram sozinhos (so se o campo ainda esta vazio).
  useEffect(() => {
    if (!cadastrado) return;
    setCliente((n) => n || cadastrado.nome);
    const padrao = cadastrado.enderecos.find((e) => e.padrao) || cadastrado.enderecos[0];
    if (padrao) setEndereco((e) => e || padrao.endereco);
  }, [cadastrado]);
  const telefoneNovo = telefone.replace(/\D/g, '').length >= 10 && !cadastrado;

  const taxa = tipo === 'entrega' ? Math.max(0, parseNumero(taxaTxt) || 0) : 0;
  const subtotal = itens.reduce((s, i) => s + i.preco * i.quantidade, 0);
  const recebido = parseNumero(recebidoTxt);
  const troco = Number.isFinite(recebido) ? recebido - (subtotal + taxa) : null;

  // "*" lista todos os produtos (ou "*texto" filtra); a lista carrega em lotes ao rolar. Sem "*", busca a partir de 2 letras.
  const modoLista = busca.trim().startsWith('*');
  const termoBusca = modoLista ? busca.trim().slice(1).trim() : busca.trim();
  useEffect(() => {
    clearTimeout(timer.current);
    if (!permitirBusca || (!modoLista && termoBusca.length < 2)) { setAchados([]); setTemMais(false); return undefined; }
    timer.current = setTimeout(async () => {
      try {
        const lote = await api.get(`/products/search?q=${encodeURIComponent(termoBusca)}&location_id=${lojaId}&limit=${LOTE}&offset=0`);
        setAchados(lote);
        setTemMais(lote.length === LOTE);
        setSel(0);
      } catch (err) { toast.erro(err); }
    }, 200);
    return () => clearTimeout(timer.current);
  }, [termoBusca, modoLista, lojaId, permitirBusca, toast]);

  async function carregarMais() {
    if (!temMais || carregandoMais) return;
    setCarregandoMais(true);
    try {
      const lote = await api.get(`/products/search?q=${encodeURIComponent(termoBusca)}&location_id=${lojaId}&limit=${LOTE}&offset=${achados.length}`);
      setAchados((atual) => [...atual, ...lote.filter((n) => !atual.some((a) => a.id === n.id))]);
      setTemMais(lote.length === LOTE);
    } catch (err) { toast.erro(err); } finally { setCarregandoMais(false); }
  }

  // Setas percorrem a lista, Enter adiciona o item escolhido.
  function teclasBusca(e) {
    if (achados.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, achados.length - 1));
      if (sel >= achados.length - 3) carregarMais();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (achados[sel]) adicionar(achados[sel]);
    }
  }
  useEffect(() => {
    const el = listaRef.current && listaRef.current.querySelector('button.sel');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [sel, achados]);

  function adicionar(p) {
    const disponivel = Number(p.saldo);
    const existente = itens.find((i) => i.product_id === p.id);
    if ((existente ? existente.quantidade : 0) + 1 > disponivel) { toast.erro(`Sem estoque disponível de ${p.nome}`); return; }
    if (existente) setItens(itens.map((i) => (i.product_id === p.id ? { ...i, quantidade: i.quantidade + 1 } : i)));
    else setItens([...itens, { product_id: p.id, nome: p.nome, unidade: p.unidade, preco: Number(p.preco_venda), quantidade: 1, observacao: '', tem_ficha: !!p.tem_ficha_tecnica, limite: disponivel }]);
    // Navegando pela lista completa (*), mantem a lista aberta para adicionar varios itens.
    if (!modoLista) { setBusca(''); setAchados([]); }
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
    if (tipo === 'mesa' && !mesa.trim()) { toast.erro('Informe a mesa.'); return; }
    const pag = PAGAMENTOS.find((p) => p.id === pagamento);
    if (jaPago && pag.forma === 'dinheiro' && !(recebido >= subtotal + taxa)) { toast.erro('Informe o valor recebido (igual ou maior que o total).'); return; }
    setSalvando(true);
    try {
      const pedido = await api.post('/orders', {
        location_id: lojaId, origem, cliente_nome: cliente, cliente_telefone: telefone.replace(/\D/g, ''), cadastrar_cliente: cadastrar, tipo, endereco: tipo === 'mesa' ? `Mesa ${mesa.trim().replace(/^mesa\s*/i, '')}` : endereco, taxa_entrega: taxa,
        observacao, forma_pagamento_prevista: pag.forma, pago: jaPago, valor_recebido: jaPago && pag.forma === 'dinheiro' ? recebido : undefined,
        itens: itens.map((i) => ({ product_id: i.product_id, quantidade: i.quantidade, observacao: i.observacao || '' })),
      });
      onCriado(pedido);
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }

  return (
    <Modal titulo={<>{titulo} <span className="ped-tag">{NOME_ORIGEM[origem]}</span></>} onClose={onClose} largura="extra">
      <div className="form-stack">
        <div className={`ped-cli-grid ${mostrarOrigem ? "" : "sem-origem"}`}>
          {mostrarOrigem && (
            <label className="field"><span className="field-label">Origem</span>
              <select value={origem} onChange={(e) => setOrigem(e.target.value)}>{ORIGENS.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}</select>
            </label>
          )}
          <ClienteTelefone solto telefone={telefone} onTelefone={setTelefone} cliente={cadastrado} onCliente={setCadastrado} rotulo="Telefone" autoFocus />
          <label className="field"><span className="field-label">Nome do cliente</span><input value={cliente} onChange={(e) => setCliente(e.target.value)} placeholder="Nome" /></label>
        </div>
        {telefoneNovo && (
          <label className="cli-check"><input type="checkbox" checked={cadastrar} onChange={(e) => setCadastrar(e.target.checked)} /> Cadastrar este cliente</label>
        )}

        <div className="field"><span className="field-label">Tipo</span>
          <div className="ped-seg2">
            <button type="button" className={tipo === 'retirada' ? 'on' : ''} onClick={() => setTipo('retirada')}>🛍 Retirada</button>
            <button type="button" className={tipo === 'entrega' ? 'on' : ''} onClick={() => setTipo('entrega')}>🛵 Entrega</button>
            <button type="button" className={tipo === 'mesa' ? 'on' : ''} onClick={() => setTipo('mesa')}>🍽 Mesa</button>
          </div>
        </div>
        {tipo === 'mesa' && (
          <label className="field"><span className="field-label">Mesa</span><input value={mesa} onChange={(e) => setMesa(e.target.value)} placeholder="Número ou nome da mesa" maxLength={30} /></label>
        )}
        {tipo === 'entrega' && cadastrado && cadastrado.enderecos.length > 1 && (
          <div className="cli-chips">{cadastrado.enderecos.map((e) => <button type="button" key={e.id} className={endereco === e.endereco ? 'on' : ''} onClick={() => setEndereco(e.endereco)}>🏠 {e.rotulo}: {e.endereco}</button>)}</div>
        )}
        {tipo === 'entrega' && (
          <div className="form-grid">
            <label className="field"><span className="field-label">Endereço</span><input value={endereco} onChange={(e) => setEndereco(e.target.value)} placeholder="Rua, nº, bairro" /></label>
            <label className="field" style={{ flex: '0 0 190px' }}><span>Taxa de entrega (R$)</span><input value={taxaTxt} onChange={(e) => setTaxaTxt(e.target.value)} inputMode="decimal" /></label>
          </div>
        )}

        <div className="ped-sec">
          <span className="ped-rotulo">Itens (estoque reservado ao confirmar)</span>
          {permitirBusca && (
            <div className="ped-busca">
              <input value={busca} onChange={(e) => setBusca(e.target.value)} onKeyDown={teclasBusca} placeholder="Buscar por nome ou código · * lista todos os produtos" />
              {achados.length > 0 && (
                <div className="ped-res" ref={listaRef} onScroll={(e) => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) carregarMais(); }}>
                  {achados.map((p, idx) => {
                    const d = Number(p.saldo);
                    return (
                      <button type="button" key={p.id} className={idx === sel ? 'sel' : ''} disabled={d <= 0} onClick={() => adicionar(p)} onMouseMove={() => { if (idx !== sel) setSel(idx); }}>
                        <span>{p.nome} <small>· {p.categoria || 'sem categoria'} · disponível {qtd(d, p.unidade)}</small></span>
                        <b>{brl(p.preco_venda)}</b>
                      </button>
                    );
                  })}
                  {modoLista && <div className="ped-res-rodape">{carregandoMais ? 'Carregando mais produtos...' : temMais ? 'Role para carregar mais' : `Fim da lista · ${achados.length} produto(s)`}</div>}
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

        <div className="ped-sec">
          <label className="field"><span className="field-label">Pagamento</span>
            <select value={pagamento} onChange={(e) => setPagamento(e.target.value)}>{PAGAMENTOS.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}</select>
          </label>
          <label className="cli-check"><input type="checkbox" checked={jaPago} onChange={(e) => setJaPago(e.target.checked)} /> Já pago (pagamento antecipado)</label>
          {jaPago && pagamento === 'dinheiro' && (
            <div className="form-grid">
              <label className="field"><span className="field-label">Valor recebido (R$)</span><input value={recebidoTxt} onChange={(e) => setRecebidoTxt(e.target.value)} inputMode="decimal" placeholder="0,00" /></label>
              <div className="field"><span className="field-label">Troco</span><b style={{ padding: '10px 0', color: troco !== null && troco >= 0 ? 'var(--ok)' : 'var(--err)' }}>{troco === null ? '—' : troco >= 0 ? brl(troco) : 'valor insuficiente'}</b></div>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Voltar</button>
          <button type="button" disabled={salvando || itens.length === 0} onClick={criar}>{salvando ? 'Gerando...' : 'Gerar pedido'}</button>
        </div>
      </div>
    </Modal>
  );
}

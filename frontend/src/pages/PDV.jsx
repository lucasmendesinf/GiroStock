import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

const TROCOS_RAPIDOS = [20, 50, 100, 200];

export default function PDV() {
  const [terminals, setTerminals] = useState([]);
  const [terminalId, setTerminalId] = useState('');
  const [session, setSession] = useState(undefined); // undefined=carregando, null=fechado
  const [valorInicial, setValorInicial] = useState('');

  const [query, setQuery] = useState('');
  const [barcode, setBarcode] = useState('');
  const [results, setResults] = useState([]);
  const [cart, setCart] = useState([]);

  const [pagamentoAberto, setPagamentoAberto] = useState(false);
  const [formaPagamento, setFormaPagamento] = useState(null);
  const [valorRecebido, setValorRecebido] = useState('');
  const [sucesso, setSucesso] = useState(null);
  const [erro, setErro] = useState(null);

  const [movModalAberto, setMovModalAberto] = useState(false);
  const [movTipo, setMovTipo] = useState('sangria');
  const [movValor, setMovValor] = useState('');
  const [movMotivo, setMovMotivo] = useState('');

  const [fecharAberto, setFecharAberto] = useState(false);
  const [valorContado, setValorContado] = useState('');
  const [fechamentoResultado, setFechamentoResultado] = useState(null);

  useEffect(() => {
    api.get('/terminals').then((rows) => {
      setTerminals(rows);
      if (rows.length > 0) setTerminalId(rows[0].id);
    });
  }, []);

  const loadSession = useCallback(async (tId) => {
    if (!tId) return;
    setSession(undefined);
    const s = await api.get(`/cash-sessions/current?terminal_id=${tId}`);
    setSession(s);
  }, []);

  useEffect(() => {
    if (terminalId) loadSession(terminalId);
  }, [terminalId, loadSession]);

  async function abrirCaixa(e) {
    e.preventDefault();
    setErro(null);
    try {
      await api.post('/cash-sessions', { terminal_id: terminalId, valor_inicial: Number(valorInicial) });
      setValorInicial('');
      await loadSession(terminalId);
    } catch (err) {
      setErro(err.message);
    }
  }

  async function buscarPorNome(q) {
    setQuery(q);
    if (q.length < 2) { setResults([]); return; }
    const rows = await api.get(`/products/search?q=${encodeURIComponent(q)}`);
    setResults(rows);
  }

  async function buscarPorCodigoBarras(e) {
    if (e.key !== 'Enter') return;
    const rows = await api.get(`/products/search?barcode=${encodeURIComponent(barcode)}`);
    if (rows.length > 0) {
      addToCart(rows[0]);
      setBarcode('');
    } else {
      setErro('Produto nao encontrado para este codigo de barras');
    }
  }

  function addToCart(product) {
    setCart((prev) => {
      const existing = prev.find((i) => i.id === product.id);
      if (existing) {
        return prev.map((i) => (i.id === product.id ? { ...i, quantidade: i.quantidade + 1 } : i));
      }
      return [...prev, { id: product.id, nome: product.nome, preco_venda: Number(product.preco_venda), quantidade: 1 }];
    });
    setResults([]);
    setQuery('');
  }

  function changeQty(id, delta) {
    setCart((prev) => prev
      .map((i) => (i.id === id ? { ...i, quantidade: i.quantidade + delta } : i))
      .filter((i) => i.quantidade > 0));
  }

  function removeItem(id) {
    setCart((prev) => prev.filter((i) => i.id !== id));
  }

  const total = cart.reduce((acc, i) => acc + i.preco_venda * i.quantidade, 0);
  const recebido = Number(valorRecebido || 0);
  const troco = formaPagamento === 'dinheiro' ? Math.max(0, recebido - total) : null;

  async function finalizarVenda() {
    setErro(null);
    try {
      const payload = {
        terminal_id: terminalId,
        itens: cart.map((i) => ({ product_id: i.id, quantidade: i.quantidade })),
        forma_pagamento: formaPagamento,
      };
      if (formaPagamento === 'dinheiro') payload.valor_recebido = recebido;

      const venda = await api.post('/sales', payload);
      setSucesso(venda);
      setCart([]);
      setPagamentoAberto(false);
      setFormaPagamento(null);
      setValorRecebido('');
    } catch (err) {
      setErro(err.message);
    }
  }

  async function registrarMovimento(e) {
    e.preventDefault();
    setErro(null);
    try {
      await api.post(`/cash-sessions/${session.id}/movements`, {
        tipo: movTipo,
        valor: Number(movValor),
        motivo: movMotivo,
      });
      setMovModalAberto(false);
      setMovValor('');
      setMovMotivo('');
    } catch (err) {
      setErro(err.message);
    }
  }

  async function fecharCaixa(e) {
    e.preventDefault();
    setErro(null);
    try {
      const resultado = await api.post(`/cash-sessions/${session.id}/close`, {
        valor_informado: Number(valorContado),
      });
      setFechamentoResultado(resultado);
    } catch (err) {
      setErro(err.message);
    }
  }

  if (session === undefined) return <p>Carregando...</p>;

  if (session === null) {
    return (
      <div className="card abertura-caixa">
        <h2>Abertura de Caixa</h2>
        <p>Terminal:</p>
        <select value={terminalId} onChange={(e) => setTerminalId(e.target.value)}>
          {terminals.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
        </select>
        <form onSubmit={abrirCaixa}>
          <label>
            Valor inicial
            <input type="number" min="0" step="0.01" value={valorInicial}
              onChange={(e) => setValorInicial(e.target.value)} required />
          </label>
          {erro && <p className="error">{erro}</p>}
          <button type="submit">Abrir caixa</button>
        </form>
      </div>
    );
  }

  if (fechamentoResultado) {
    return (
      <div className="card">
        <h2>Caixa fechado</h2>
        <p>Valor esperado: R$ {Number(fechamentoResultado.valor_esperado_fechamento).toFixed(2)}</p>
        <p>Valor informado: R$ {Number(fechamentoResultado.valor_informado_fechamento).toFixed(2)}</p>
        <p>Diferenca: R$ {Number(fechamentoResultado.diferenca).toFixed(2)}</p>
        <button onClick={() => { setFecharAberto(false); setFechamentoResultado(null); loadSession(terminalId); }}>
          Voltar ao PDV
        </button>
      </div>
    );
  }

  return (
    <div className="pdv-screen">
      <div className="pdv-header">
        <select value={terminalId} onChange={(e) => setTerminalId(e.target.value)}>
          {terminals.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
        </select>
        <button onClick={() => setMovModalAberto(true)}>Sangria/Suprimento</button>
        <button onClick={() => setFecharAberto(true)}>Fechar caixa</button>
      </div>

      {erro && <p className="error">{erro}</p>}

      <div className="pdv-body">
        <div className="pdv-busca">
          <input placeholder="Buscar produto por nome..." value={query} onChange={(e) => buscarPorNome(e.target.value)} />
          <input placeholder="Codigo de barras + Enter" value={barcode}
            onChange={(e) => setBarcode(e.target.value)} onKeyDown={buscarPorCodigoBarras} />
          <ul className="resultados">
            {results.map((p) => (
              <li key={p.id} onClick={() => addToCart(p)}>
                {p.nome} — R$ {Number(p.preco_venda).toFixed(2)}
              </li>
            ))}
          </ul>
        </div>

        <div className="pdv-carrinho">
          <h3>Carrinho</h3>
          {cart.length === 0 && <p>Carrinho vazio</p>}
          {cart.map((i) => (
            <div key={i.id} className="carrinho-item">
              <span>{i.nome}</span>
              <div>
                <button onClick={() => changeQty(i.id, -1)}>-</button>
                <span>{i.quantidade}</span>
                <button onClick={() => changeQty(i.id, 1)}>+</button>
              </div>
              <span>R$ {(i.preco_venda * i.quantidade).toFixed(2)}</span>
              <button onClick={() => removeItem(i.id)}>x</button>
            </div>
          ))}
          <h2>Total: R$ {total.toFixed(2)}</h2>
          <button disabled={cart.length === 0} onClick={() => setPagamentoAberto(true)}>Finalizar venda</button>
        </div>
      </div>

      {pagamentoAberto && (
        <div className="modal">
          <div className="modal-content">
            <h3>Forma de pagamento</h3>
            <div className="formas-pagamento">
              {['pix', 'cartao_credito', 'cartao_debito', 'dinheiro'].map((f) => (
                <button key={f} className={formaPagamento === f ? 'ativo' : ''} onClick={() => setFormaPagamento(f)}>
                  {f.replace('_', ' ')}
                </button>
              ))}
            </div>
            {formaPagamento === 'dinheiro' && (
              <div>
                <label>
                  Valor recebido
                  <input type="number" step="0.01" value={valorRecebido} onChange={(e) => setValorRecebido(e.target.value)} />
                </label>
                <div className="trocos-rapidos">
                  {TROCOS_RAPIDOS.filter((v) => v >= total).map((v) => (
                    <button key={v} onClick={() => setValorRecebido(String(v))}>R$ {v}</button>
                  ))}
                </div>
                <p>Troco: R$ {troco !== null ? troco.toFixed(2) : '0.00'}</p>
              </div>
            )}
            {erro && <p className="error">{erro}</p>}
            <div className="modal-actions">
              <button onClick={() => setPagamentoAberto(false)}>Cancelar</button>
              <button
                disabled={!formaPagamento || (formaPagamento === 'dinheiro' && recebido < total)}
                onClick={finalizarVenda}
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {sucesso && (
        <div className="modal">
          <div className="modal-content">
            <h3>Venda concluida!</h3>
            <p>Pedido: {sucesso.id}</p>
            <p>Forma: {sucesso.forma_pagamento}</p>
            <p>Total: R$ {Number(sucesso.total).toFixed(2)}</p>
            {sucesso.troco !== null && <p>Troco: R$ {Number(sucesso.troco).toFixed(2)}</p>}
            <button onClick={() => setSucesso(null)}>Nova venda</button>
          </div>
        </div>
      )}

      {movModalAberto && (
        <div className="modal">
          <form className="modal-content" onSubmit={registrarMovimento}>
            <h3>Sangria / Suprimento</h3>
            <select value={movTipo} onChange={(e) => setMovTipo(e.target.value)}>
              <option value="sangria">Sangria</option>
              <option value="suprimento">Suprimento</option>
            </select>
            <label>
              Valor
              <input type="number" step="0.01" min="0.01" value={movValor} onChange={(e) => setMovValor(e.target.value)} required />
            </label>
            <label>
              Motivo
              <input value={movMotivo} onChange={(e) => setMovMotivo(e.target.value)} required />
            </label>
            {erro && <p className="error">{erro}</p>}
            <div className="modal-actions">
              <button type="button" onClick={() => setMovModalAberto(false)}>Cancelar</button>
              <button type="submit">Confirmar</button>
            </div>
          </form>
        </div>
      )}

      {fecharAberto && (
        <div className="modal">
          <form className="modal-content" onSubmit={fecharCaixa}>
            <h3>Fechar caixa</h3>
            <label>
              Valor contado
              <input type="number" step="0.01" min="0" value={valorContado} onChange={(e) => setValorContado(e.target.value)} required />
            </label>
            {erro && <p className="error">{erro}</p>}
            <div className="modal-actions">
              <button type="button" onClick={() => setFecharAberto(false)}>Cancelar</button>
              <button type="submit">Fechar</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

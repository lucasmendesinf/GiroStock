import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api/client';
import { requestFullscreen, isFullscreen as checkIsFullscreen } from '../utils/fullscreen';
import { brl, qtd, parseNumero, dataHora, UNIDADES_INTEIRAS, FORMA_PAGAMENTO } from '../utils/format';
import { useToast, useConfirm } from '../context/UiContext.jsx';
import { Field, Modal } from '../components/ui.jsx';
import Cupom, { imprimirCupom as abrirImpressao } from '../components/Cupom.jsx';

const TROCOS_RAPIDOS = [10, 20, 50, 100, 200];
const FORMAS = ['pix', 'cartao_credito', 'cartao_debito', 'dinheiro'];
// "3*7891234567890" ou "0,350*7891234567890": quantidade antes do asterisco.
const RE_QTD = /^(\d+(?:[.,]\d+)?)\s*\*\s*(.+)$/;

function ehCodigoDeBarras(texto) {
  return /^\d{8,14}$/.test(texto);
}

export default function PDV() {
  const toast = useToast();
  const confirmar = useConfirm();

  // ---------- tela cheia ----------
  const [mostrarDicaEsc, setMostrarDicaEsc] = useState(false);
  useEffect(() => {
    requestFullscreen();
    function onFullscreenChange() {
      if (checkIsFullscreen()) {
        setMostrarDicaEsc(true);
        setTimeout(() => setMostrarDicaEsc(false), 4000);
      }
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    };
  }, []);

  // ---------- terminal e caixa ----------
  const [terminals, setTerminals] = useState([]);
  const [terminalId, setTerminalId] = useState(() => localStorage.getItem('girostock_terminal') || '');
  const [session, setSession] = useState(undefined); // undefined=carregando, null=fechado
  const [valorInicial, setValorInicial] = useState('');
  const terminal = terminals.find((t) => t.id === terminalId);

  useEffect(() => {
    // So PDVs ativos (o backend ja limita aos da loja do usuario, se ele tiver uma).
    api.get('/terminals').then((rows) => {
      const ativos = rows.filter((t) => t.ativo);
      setTerminals(ativos);
      setTerminalId((atual) => (ativos.some((t) => t.id === atual) ? atual : (ativos[0] && ativos[0].id) || ''));
      if (ativos.length === 0) setSession(null);
    }).catch((err) => toast.erro(err));
  }, [toast]);

  const loadSession = useCallback(async (tId) => {
    if (!tId) return;
    setSession(undefined);
    try {
      setSession(await api.get(`/cash-sessions/current?terminal_id=${tId}`));
    } catch (err) {
      toast.erro(err);
      setSession(null);
    }
  }, [toast]);

  const [cart, setCart] = useState([]);
  useEffect(() => {
    // O carrinho e validado contra o estoque da loja do terminal: trocar de terminal limpa o carrinho.
    setCart([]);
    setResults([]);
    if (terminalId) {
      localStorage.setItem('girostock_terminal', terminalId);
      loadSession(terminalId);
    }
  }, [terminalId, loadSession]);

  async function abrirCaixa(e) {
    e.preventDefault();
    const valor = parseNumero(valorInicial || '0');
    if (!(valor >= 0)) { toast.erro('Informe um valor inicial válido.'); return; }
    try {
      await api.post('/cash-sessions', { terminal_id: terminalId, valor_inicial: valor });
      setValorInicial('');
      toast.sucesso('Caixa aberto. Boas vendas!');
      await loadSession(terminalId);
    } catch (err) { toast.erro(err); }
  }

  // ---------- busca e carrinho ----------
  const [busca, setBusca] = useState('');
  const [results, setResults] = useState([]);
  const [selecionado, setSelecionado] = useState(0);
  const buscaRef = useRef(null);
  const qtdRefs = useRef({});
  const [editandoQtd, setEditandoQtd] = useState({});
  const timerBusca = useRef(null);

  const focarBusca = useCallback(() => setTimeout(() => buscaRef.current?.focus(), 0), []);

  function limiteDe(product) {
    return product.tem_ficha_tecnica || product.saldo === null || product.saldo === undefined ? Infinity : Number(product.saldo);
  }

  function onBuscaChange(texto) {
    setBusca(texto);
    setSelecionado(0);
    clearTimeout(timerBusca.current);
    const termo = (texto.match(RE_QTD) || [null, null, texto])[2].trim();
    // Codigo numerico so e buscado no Enter (leitor de codigo de barras envia Enter no final).
    if (termo.length < 2 || /^\d+$/.test(termo)) { setResults([]); return; }
    timerBusca.current = setTimeout(async () => {
      try {
        setResults(await api.get(`/products/search?q=${encodeURIComponent(termo)}&terminal_id=${terminalId}`));
      } catch (err) { toast.erro(err); }
    }, 180);
  }

  // Adiciona ao carrinho respeitando o saldo da loja. quantidade null = 1 (ou peso a informar).
  function addToCart(product, quantidadeInformada = null) {
    const fracionado = !UNIDADES_INTEIRAS.includes(product.unidade);
    const quantidade = quantidadeInformada ?? 1;
    if (!fracionado && !Number.isInteger(quantidade)) {
      toast.erro(`"${product.nome}" é vendido em ${product.unidade}: use quantidade inteira.`);
      return false;
    }
    const limite = limiteDe(product);
    const noCarrinho = cart.find((i) => i.id === product.id);
    const novaQtd = (noCarrinho ? noCarrinho.quantidade : 0) + quantidade;
    if (novaQtd > limite) {
      toast.erro(limite <= 0 ? `"${product.nome}" está sem estoque nesta loja.` : `"${product.nome}": só há ${qtd(limite, product.unidade)} em estoque nesta loja.`);
      return false;
    }
    setCart((prev) => {
      if (prev.some((i) => i.id === product.id)) {
        return prev.map((i) => (i.id === product.id ? { ...i, quantidade: novaQtd } : i));
      }
      return [...prev, {
        id: product.id, nome: product.nome, unidade: product.unidade, preco_venda: Number(product.preco_venda),
        quantidade, limite,
      }];
    });
    // Produto por peso/volume adicionado sem quantidade: abre o campo para digitar o peso.
    if (fracionado && quantidadeInformada === null && !noCarrinho) {
      setTimeout(() => {
        setEditandoQtd((e) => ({ ...e, [product.id]: '1' }));
        setTimeout(() => qtdRefs.current[product.id]?.select(), 30);
      }, 0);
      return true;
    }
    focarBusca();
    return true;
  }

  async function onBuscaKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelecionado((s) => Math.min(s + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelecionado((s) => Math.max(s - 1, 0)); return; }
    if (e.key === 'Escape') { setBusca(''); setResults([]); return; }
    if (e.key === 'Delete' && busca === '' && cart.length > 0) {
      e.preventDefault();
      setCart((prev) => prev.slice(0, -1));
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const texto = busca.trim();
    if (!texto) return;

    let quantidade = null;
    let termo = texto;
    const m = texto.match(RE_QTD);
    if (m) {
      quantidade = parseNumero(m[1]);
      termo = m[2].trim();
      if (!(quantidade > 0)) { toast.erro('Quantidade inválida antes do *.'); return; }
    }

    let adicionou = false;
    if (ehCodigoDeBarras(termo)) {
      try {
        const rows = await api.get(`/products/search?barcode=${encodeURIComponent(termo)}&terminal_id=${terminalId}`);
        if (rows.length === 0) toast.erro(`Código ${termo} não encontrado (ou produto inativo).`);
        else adicionou = addToCart(rows[0], quantidade);
      } catch (err) { toast.erro(err); }
    } else if (results.length > 0) {
      adicionou = addToCart(results[Math.min(selecionado, results.length - 1)], quantidade);
    } else {
      toast.erro(`Nenhum produto com estoque nesta loja para "${termo}".`);
    }
    if (adicionou) {
      setBusca('');
      setResults([]);
    }
  }

  function setQuantidade(item, valor) {
    const nova = parseNumero(valor);
    if (!(nova > 0)) { removeItem(item.id); return; }
    if (UNIDADES_INTEIRAS.includes(item.unidade) && !Number.isInteger(nova)) {
      toast.erro(`"${item.nome}" só aceita quantidade inteira.`);
      return;
    }
    if (nova > item.limite) {
      toast.erro(`"${item.nome}": só há ${qtd(item.limite, item.unidade)} em estoque nesta loja.`);
      return;
    }
    setCart((prev) => prev.map((i) => (i.id === item.id ? { ...i, quantidade: nova } : i)));
  }

  function confirmarQtdDigitada(item) {
    const valor = editandoQtd[item.id];
    setEditandoQtd((e) => { const c = { ...e }; delete c[item.id]; return c; });
    if (valor !== undefined) setQuantidade(item, valor);
    focarBusca();
  }

  function changeQty(item, delta) {
    setQuantidade(item, item.quantidade + delta);
  }

  function removeItem(id) {
    setCart((prev) => prev.filter((i) => i.id !== id));
    focarBusca();
  }

  async function cancelarVendaAtual() {
    if (cart.length === 0) return;
    if (await confirmar({ titulo: 'Cancelar esta venda?', mensagem: 'Todos os itens do carrinho serão removidos.', confirmar: 'Limpar carrinho', perigo: true })) {
      setCart([]);
    }
    focarBusca();
  }

  const subtotal = Number(cart.reduce((acc, i) => acc + i.preco_venda * i.quantidade, 0).toFixed(2));

  // ---------- pagamento ----------
  const [pagamentoAberto, setPagamentoAberto] = useState(false);
  const [formaPagamento, setFormaPagamento] = useState(null);
  const [valorRecebido, setValorRecebido] = useState('');
  const [descontoTexto, setDescontoTexto] = useState('');
  const [descontoTipo, setDescontoTipo] = useState('valor'); // valor | percentual
  const [enviando, setEnviando] = useState(false);
  const recebidoRef = useRef(null);

  const descontoNumero = parseNumero(descontoTexto || '0');
  const desconto = Number.isFinite(descontoNumero) && descontoNumero > 0
    ? Number((descontoTipo === 'percentual' ? subtotal * (descontoNumero / 100) : descontoNumero).toFixed(2))
    : 0;
  const total = Number(Math.max(0, subtotal - desconto).toFixed(2));
  const descontoInvalido = desconto >= subtotal && desconto > 0;
  const recebido = parseNumero(valorRecebido);
  const troco = formaPagamento === 'dinheiro' && Number.isFinite(recebido) ? recebido - total : null;
  const podeConfirmar = !!formaPagamento && !descontoInvalido && !enviando
    && (formaPagamento !== 'dinheiro' || (Number.isFinite(recebido) && recebido >= total));

  function abrirPagamento() {
    if (cart.length === 0) return;
    setFormaPagamento(null);
    setValorRecebido('');
    setDescontoTexto('');
    setDescontoTipo('valor');
    setPagamentoAberto(true);
    buscaRef.current?.blur();
  }

  function escolherForma(f) {
    setFormaPagamento(f);
    if (f === 'dinheiro') setTimeout(() => recebidoRef.current?.focus(), 0);
  }

  async function finalizarVenda() {
    if (!podeConfirmar) return;
    setEnviando(true);
    try {
      const payload = {
        terminal_id: terminalId,
        itens: cart.map((i) => ({ product_id: i.id, quantidade: i.quantidade })),
        forma_pagamento: formaPagamento,
        desconto,
      };
      if (formaPagamento === 'dinheiro') payload.valor_recebido = recebido;
      const venda = await api.post('/sales', payload);
      setSucesso(venda);
      setUltimaVendaId(venda.id);
      setCart([]);
      setPagamentoAberto(false);
    } catch (err) {
      toast.erro(err);
    } finally {
      setEnviando(false);
    }
  }

  // ---------- venda concluida e cupom ----------
  const [sucesso, setSucesso] = useState(null);
  const [ultimaVendaId, setUltimaVendaId] = useState(null);
  const [cupom, setCupom] = useState(null);

  async function imprimirCupom(vendaId) {
    try {
      abrirImpressao(setCupom, await api.get(`/sales/${vendaId}`));
    } catch (err) { toast.erro(err); }
  }

  function novaVenda() {
    setSucesso(null);
    focarBusca();
  }

  // ---------- sangria / suprimento / fechamento ----------
  const [movModalAberto, setMovModalAberto] = useState(false);
  const [movTipo, setMovTipo] = useState('sangria');
  const [movValor, setMovValor] = useState('');
  const [movMotivo, setMovMotivo] = useState('');
  const [fecharAberto, setFecharAberto] = useState(false);
  const [valorContado, setValorContado] = useState('');
  const [fechamentoResultado, setFechamentoResultado] = useState(null);

  async function registrarMovimento(e) {
    e.preventDefault();
    try {
      await api.post(`/cash-sessions/${session.id}/movements`, { tipo: movTipo, valor: parseNumero(movValor), motivo: movMotivo });
      toast.sucesso(movTipo === 'sangria' ? 'Sangria registrada.' : 'Suprimento registrado.');
      setMovModalAberto(false);
      setMovValor('');
      setMovMotivo('');
      focarBusca();
    } catch (err) { toast.erro(err); }
  }

  async function fecharCaixa(e) {
    e.preventDefault();
    if (cart.length > 0) { toast.erro('Finalize ou cancele a venda em andamento antes de fechar o caixa.'); return; }
    try {
      const resultado = await api.post(`/cash-sessions/${session.id}/close`, { valor_informado: parseNumero(valorContado || '0') });
      setFecharAberto(false);
      setValorContado('');
      setFechamentoResultado(resultado);
    } catch (err) { toast.erro(err); }
  }

  // ---------- atalhos de teclado ----------
  const algumModal = pagamentoAberto || !!sucesso || movModalAberto || fecharAberto;
  useEffect(() => {
    if (!session) return undefined;
    function onKey(e) {
      if (sucesso) {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); novaVenda(); }
        if (e.key.toLowerCase() === 'p' || e.key === 'F9') { e.preventDefault(); imprimirCupom(sucesso.id); }
        return;
      }
      if (pagamentoAberto) {
        if (e.key === 'Escape') { setPagamentoAberto(false); focarBusca(); return; }
        const alvo = e.target.tagName;
        // Numeros escolhem a forma, exceto quando se digita num campo da janela de pagamento.
        const digitandoNoModal = alvo === 'INPUT' && e.target.closest && e.target.closest('.modal');
        if (['1', '2', '3', '4'].includes(e.key) && !digitandoNoModal) { e.preventDefault(); escolherForma(FORMAS[Number(e.key) - 1]); return; }
        if (e.key === 'F2' || (e.key === 'Enter' && alvo !== 'BUTTON')) { e.preventDefault(); finalizarVenda(); }
        return;
      }
      if (algumModal) return;
      if (e.key === 'F2') { e.preventDefault(); abrirPagamento(); }
      if (e.key === 'F4') { e.preventDefault(); setMovModalAberto(true); }
      if (e.key === 'F6') { e.preventDefault(); cancelarVendaAtual(); }
      if (e.key === 'F8') { e.preventDefault(); setFecharAberto(true); }
      if (e.key === 'F9' && ultimaVendaId) { e.preventDefault(); imprimirCupom(ultimaVendaId); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (session && !algumModal) focarBusca();
  }, [session, algumModal, focarBusca]);

  const dicaEsc = mostrarDicaEsc && (
    <div className="fullscreen-hint">Tela cheia ativada — pressione <strong>Esc</strong> para sair da tela cheia</div>
  );

  // ---------- telas ----------
  if (session === undefined) return (<>{dicaEsc}<p className="muted">Carregando...</p></>);

  if (fechamentoResultado) {
    const dif = Number(fechamentoResultado.diferenca);
    return (
      <div className="card abertura-caixa">
        <h2>Caixa fechado</h2>
        <ul className="lista-simples">
          <li><span>Valor esperado em dinheiro</span><strong>{brl(fechamentoResultado.valor_esperado_fechamento)}</strong></li>
          <li><span>Valor contado</span><strong>{brl(fechamentoResultado.valor_informado_fechamento)}</strong></li>
          <li><span>Diferença</span><strong style={{ color: dif === 0 ? 'var(--ok)' : 'var(--err)' }}>{dif > 0 ? '+' : ''}{brl(dif)} {dif === 0 ? '(conferido)' : dif > 0 ? '(sobra)' : '(falta)'}</strong></li>
        </ul>
        <button className="btn-primario" onClick={() => { setFechamentoResultado(null); loadSession(terminalId); }}>Voltar</button>
      </div>
    );
  }

  if (session === null) {
    return (
      <>
        {dicaEsc}
        <div className="card abertura-caixa">
          <h2>Abertura de caixa</h2>
          {terminals.length === 0 ? (
            <p className="error">Nenhum PDV ativo disponível para o seu usuário. Peça a um administrador para cadastrar um PDV em "Lojas &amp; PDVs".</p>
          ) : (
            <form onSubmit={abrirCaixa} className="form-stack">
              <Field label="Terminal (PDV)">
                <select value={terminalId} onChange={(e) => setTerminalId(e.target.value)}>
                  {terminals.map((t) => <option key={t.id} value={t.id}>{t.nome} — {t.location_nome}</option>)}
                </select>
              </Field>
              <Field label="Valor inicial em dinheiro (troco)" hint="Ex: 100,00">
                <input inputMode="decimal" autoFocus value={valorInicial} onChange={(e) => setValorInicial(e.target.value)} placeholder="0,00" />
              </Field>
              <button type="submit" className="btn-primario" disabled={!terminalId}>Abrir caixa</button>
            </form>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="pdv-screen">
      {dicaEsc}
      <div className="pdv-header">
        <select value={terminalId} onChange={(e) => setTerminalId(e.target.value)} disabled={cart.length > 0} title={cart.length > 0 ? 'Finalize a venda para trocar de terminal' : ''}>
          {terminals.map((t) => <option key={t.id} value={t.id}>{t.nome} — {t.location_nome}</option>)}
        </select>
        <span className="pdv-caixa-info">Caixa aberto às {dataHora(session.aberto_em).slice(-5)}</span>
        <div className="pdv-header-acoes">
          <button onClick={() => setMovModalAberto(true)}>Sangria/Suprimento <kbd>F4</kbd></button>
          {ultimaVendaId && <button onClick={() => imprimirCupom(ultimaVendaId)}>Reimprimir cupom <kbd>F9</kbd></button>}
          <button onClick={() => setFecharAberto(true)}>Fechar caixa <kbd>F8</kbd></button>
        </div>
      </div>

      <div className="pdv-body">
        <div className="pdv-busca">
          <input
            ref={buscaRef}
            className="pdv-campo"
            placeholder="Código de barras ou nome do produto  ·  3*código para quantidade"
            value={busca}
            onChange={(e) => onBuscaChange(e.target.value)}
            onKeyDown={onBuscaKeyDown}
            autoFocus
            aria-label="Buscar produto"
          />
          <ul className="resultados" role="listbox">
            {results.map((p, i) => (
              <li key={p.id} role="option" aria-selected={i === selecionado} className={i === selecionado ? 'selecionado' : ''}
                onMouseEnter={() => setSelecionado(i)} onClick={() => { if (addToCart(p)) { setBusca(''); setResults([]); } }}>
                <span className="resultado-nome">{p.nome}</span>
                <span className="resultado-preco">{brl(p.preco_venda)}{p.unidade !== 'UN' ? ` / ${p.unidade}` : ''}</span>
                <span className="saldo-pdv">{p.tem_ficha_tecnica ? 'preparo' : `estoque: ${qtd(p.saldo, p.unidade)}`}</span>
              </li>
            ))}
          </ul>
          <div className="atalhos">
            <span><kbd>Enter</kbd> adiciona</span>
            <span><kbd>↑</kbd><kbd>↓</kbd> escolhe</span>
            <span><kbd>3*</kbd> quantidade</span>
            <span><kbd>Del</kbd> tira o último</span>
            <span><kbd>F2</kbd> pagamento</span>
            <span><kbd>F6</kbd> cancelar venda</span>
          </div>
        </div>

        <div className="pdv-carrinho">
          <div className="carrinho-topo">
            <h3>Carrinho {cart.length > 0 && <span className="muted">({cart.length} {cart.length === 1 ? 'item' : 'itens'})</span>}</h3>
            {cart.length > 0 && <button type="button" className="btn-link perigo" onClick={cancelarVendaAtual}>Cancelar venda</button>}
          </div>
          {cart.length === 0 && <p className="muted">Passe um produto no leitor ou digite o nome.</p>}
          <div className="carrinho-lista">
            {cart.map((i) => (
              <div key={i.id} className="carrinho-item">
                <div className="carrinho-info">
                  <span className="carrinho-nome">{i.nome}</span>
                  <span className="muted">{qtd(i.quantidade, i.unidade)} {i.unidade} × {brl(i.preco_venda)}</span>
                </div>
                <div className="carrinho-qtd">
                  <button type="button" aria-label="Diminuir" onClick={() => changeQty(i, -1)} disabled={!UNIDADES_INTEIRAS.includes(i.unidade) && i.quantidade <= 1}>−</button>
                  <input
                    ref={(el) => { qtdRefs.current[i.id] = el; }}
                    inputMode="decimal"
                    aria-label={`Quantidade de ${i.nome}`}
                    value={editandoQtd[i.id] ?? qtd(i.quantidade, i.unidade)}
                    onFocus={(e) => { setEditandoQtd((x) => ({ ...x, [i.id]: qtd(i.quantidade, i.unidade) })); setTimeout(() => e.target.select(), 0); }}
                    onChange={(e) => setEditandoQtd((x) => ({ ...x, [i.id]: e.target.value }))}
                    onBlur={() => confirmarQtdDigitada(i)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }}
                  />
                  <button type="button" aria-label="Aumentar" onClick={() => changeQty(i, 1)}>+</button>
                </div>
                <span className="carrinho-subtotal">{brl(i.preco_venda * i.quantidade)}</span>
                <button type="button" className="carrinho-remover" aria-label={`Remover ${i.nome}`} onClick={() => removeItem(i.id)}>×</button>
              </div>
            ))}
          </div>
          <div className="carrinho-total">
            <span>Total</span>
            <strong>{brl(subtotal)}</strong>
          </div>
          <button className="btn-finalizar" disabled={cart.length === 0} onClick={abrirPagamento}>Finalizar venda <kbd>F2</kbd></button>
        </div>
      </div>

      {pagamentoAberto && (
        <Modal titulo="Pagamento" subtitulo={`${cart.length} ${cart.length === 1 ? 'item' : 'itens'} · subtotal ${brl(subtotal)}`} onClose={() => setPagamentoAberto(false)}>
          <div className="formas-pagamento">
            {FORMAS.map((f, idx) => (
              <button key={f} type="button" className={formaPagamento === f ? 'ativo' : ''} onClick={() => escolherForma(f)}>
                <kbd>{idx + 1}</kbd> {FORMA_PAGAMENTO[f]}
              </button>
            ))}
          </div>

          <div className="form-grid">
            <Field label="Desconto">
              <div className="input-com-seletor">
                <input inputMode="decimal" placeholder="0" value={descontoTexto} onChange={(e) => setDescontoTexto(e.target.value)} />
                <select value={descontoTipo} onChange={(e) => setDescontoTipo(e.target.value)} aria-label="Tipo de desconto">
                  <option value="valor">R$</option>
                  <option value="percentual">%</option>
                </select>
              </div>
            </Field>
            {formaPagamento === 'dinheiro' && (
              <Field label="Valor recebido">
                <input ref={recebidoRef} inputMode="decimal" placeholder="0,00" value={valorRecebido} onChange={(e) => setValorRecebido(e.target.value)} />
              </Field>
            )}
          </div>
          {descontoInvalido && <p className="error">O desconto não pode ser igual ou maior que o subtotal.</p>}

          {formaPagamento === 'dinheiro' && (
            <div className="trocos-rapidos">
              <button type="button" onClick={() => setValorRecebido(String(total).replace('.', ','))}>Valor exato</button>
              {TROCOS_RAPIDOS.filter((v) => v > total).slice(0, 4).map((v) => (
                <button type="button" key={v} onClick={() => setValorRecebido(String(v))}>{brl(v)}</button>
              ))}
            </div>
          )}

          <div className="pagamento-resumo">
            {desconto > 0 && <div><span>Desconto</span><span>− {brl(desconto)}</span></div>}
            <div className="pagamento-total"><span>Total a pagar</span><strong>{brl(total)}</strong></div>
            {troco !== null && (
              <div className={troco < 0 ? 'falta' : 'troco'}>
                <span>{troco < 0 ? 'Falta' : 'Troco'}</span><strong>{brl(Math.abs(troco))}</strong>
              </div>
            )}
          </div>

          <div className="modal-actions">
            <button type="button" onClick={() => setPagamentoAberto(false)}>Voltar <kbd>Esc</kbd></button>
            <button type="button" disabled={!podeConfirmar} onClick={finalizarVenda}>{enviando ? 'Registrando...' : 'Confirmar'} <kbd>Enter</kbd></button>
          </div>
        </Modal>
      )}

      {sucesso && (
        <Modal titulo={`Venda nº ${sucesso.numero} concluída`} onClose={novaVenda}>
          <div className="pagamento-resumo">
            <div><span>Forma</span><span>{FORMA_PAGAMENTO[sucesso.forma_pagamento]}</span></div>
            {Number(sucesso.desconto) > 0 && <div><span>Desconto</span><span>− {brl(sucesso.desconto)}</span></div>}
            <div className="pagamento-total"><span>Total</span><strong>{brl(sucesso.total)}</strong></div>
            {sucesso.troco !== null && <div className="troco destaque"><span>Troco</span><strong>{brl(sucesso.troco)}</strong></div>}
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => imprimirCupom(sucesso.id)}>Imprimir cupom <kbd>P</kbd></button>
            <button type="button" autoFocus onClick={novaVenda}>Nova venda <kbd>Enter</kbd></button>
          </div>
        </Modal>
      )}

      {movModalAberto && (
        <Modal titulo="Sangria / Suprimento" onClose={() => setMovModalAberto(false)}>
          <form className="form-stack" onSubmit={registrarMovimento}>
            <div className="formas-pagamento">
              <button type="button" className={movTipo === 'sangria' ? 'ativo' : ''} onClick={() => setMovTipo('sangria')}>Sangria (retirada)</button>
              <button type="button" className={movTipo === 'suprimento' ? 'ativo' : ''} onClick={() => setMovTipo('suprimento')}>Suprimento (reforço)</button>
            </div>
            <Field label="Valor"><input inputMode="decimal" autoFocus placeholder="0,00" value={movValor} onChange={(e) => setMovValor(e.target.value)} required /></Field>
            <Field label="Motivo"><input value={movMotivo} onChange={(e) => setMovMotivo(e.target.value)} placeholder="Ex: depósito no banco" required /></Field>
            <div className="modal-actions">
              <button type="button" onClick={() => setMovModalAberto(false)}>Voltar</button>
              <button type="submit">Registrar</button>
            </div>
          </form>
        </Modal>
      )}

      {fecharAberto && (
        <Modal titulo="Fechar caixa" subtitulo="Conte o dinheiro da gaveta e informe o total." onClose={() => setFecharAberto(false)}>
          <form className="form-stack" onSubmit={fecharCaixa}>
            <Field label="Valor contado em dinheiro"><input inputMode="decimal" autoFocus placeholder="0,00" value={valorContado} onChange={(e) => setValorContado(e.target.value)} required /></Field>
            <div className="modal-actions">
              <button type="button" onClick={() => setFecharAberto(false)}>Voltar</button>
              <button type="submit">Fechar caixa</button>
            </div>
          </form>
        </Modal>
      )}

      {cupom && <Cupom venda={cupom} />}
    </div>
  );
}

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { api } from '../api/client';
import { requestFullscreen, isFullscreen as checkIsFullscreen } from '../utils/fullscreen';
import { brl, qtd, parseNumero, dataHora, UNIDADES_INTEIRAS, FORMA_PAGAMENTO } from '../utils/format';
import { useToast, useConfirm } from '../context/UiContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useNavigate, useLocation } from 'react-router-dom';
import { podeAcessar, telasDoUsuario } from '../utils/permissions';
import PedidoForm, { ORIGENS, NOME_ORIGEM, PAGAMENTOS, vendaDoPedido } from '../components/PedidoForm.jsx';
import { Field, Modal } from '../components/ui.jsx';
import ClienteTelefone from '../components/ClienteTelefone.jsx';
import Cupom, { imprimirCupom as abrirImpressao, modoAutomatico, configDaVenda } from '../components/Cupom.jsx';
import EscolherComplementos, { assinatura, precoComplementos, textoComplementos } from '../components/EscolherComplementos.jsx';

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
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const podeSangria = podeAcessar(user, 'SangriaSuprimento');
  const podeDesconto = podeAcessar(user, 'Desconto');
  const podeFechar = podeAcessar(user, 'FecharCaixa');

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
  const [escolhendo, setEscolhendo] = useState(null); // { product, quantidade }: escolha dos complementos antes de entrar no carrinho
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
  const [buscaFocada, setBuscaFocada] = useState(false);
  const [results, setResults] = useState([]);
  const [selecionado, setSelecionado] = useState(0);
  const itemSelecionadoRef = useRef(null);
  // Lista completa (busca iniciada por *): carrega em lotes conforme a rolagem.
  const LOTE = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 100 : 30; // 100 = maximo da API
  const [temMais, setTemMais] = useState(false);
  const [carregandoMais, setCarregandoMais] = useState(false);
  const listaAtual = useRef(null); // termo da lista completa em exibicao (null = busca normal)
  const buscaRef = useRef(null);
  const qtdRefs = useRef({});
  const proximaLinha = useRef(1);
  const [editandoQtd, setEditandoQtd] = useState({});
  const timerBusca = useRef(null);

  // Celular/tablet (garcom na mesa): sem teclado fisico. A lista de produtos fica aberta, tocar adiciona e o campo
  // de busca nao recebe foco sozinho (senao o teclado virtual abre a cada item).
  const toque = useMemo(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches, []);
  const [categoria, setCategoria] = useState(null); // filtro por categoria na lista (toque)
  const focarBusca = useCallback(() => { if (!toque) setTimeout(() => buscaRef.current?.focus(), 0); }, [toque]);

  // Toque: com a busca vazia, a lista de produtos (cardapio) fica sempre aberta.
  useEffect(() => {
    if (toque && session && terminalId && busca === '' && results.length === 0) onBuscaChange('');
  }, [toque, session, terminalId, busca, results.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enquanto se digita na busca (toque), os avisos ficam escondidos: no topo da tela eles cobririam o campo.
  useEffect(() => {
    document.body.classList.toggle('pdv-digitando', toque && buscaFocada);
    return () => document.body.classList.remove('pdv-digitando');
  }, [toque, buscaFocada]);

  // Barra fixa do celular (total + ir ao carrinho) some quando o botao de finalizar ja esta na tela.
  const finalizarRef = useRef(null);
  const [finalizarVisivel, setFinalizarVisivel] = useState(true);
  useEffect(() => {
    const el = finalizarRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const obs = new IntersectionObserver(([e]) => setFinalizarVisivel(e.isIntersecting), { threshold: 0.5 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [session, cart.length === 0]);

  // A seta para baixo/cima acompanha o item escolhido com a rolagem da lista.
  useEffect(() => {
    if (itemSelecionadoRef.current) itemSelecionadoRef.current.scrollIntoView({ block: 'nearest' });
  }, [selecionado, results]);

  function limiteDe(product) {
    return product.saldo === null || product.saldo === undefined ? Infinity : Number(product.saldo);
  }

  function msgSemEstoque(product, limite) {
    if (product.tem_ficha_tecnica) {
      return limite <= 0
        ? `"${product.nome}" sem estoque: falta insumo${product.insumo_limitante ? ` (${product.insumo_limitante})` : ''} nesta loja.`
        : `"${product.nome}": os insumos só dão para ${limite} unidade(s) nesta loja${product.insumo_limitante ? ` (limite: ${product.insumo_limitante})` : ''}.`;
    }
    return limite <= 0 ? `"${product.nome}" está sem estoque nesta loja.` : `"${product.nome}": só há ${qtd(limite, product.unidade)} em estoque nesta loja.`;
  }

  function onBuscaChange(texto) {
    setBusca(texto);
    setSelecionado(0);
    clearTimeout(timerBusca.current);
    // "*" lista todos os produtos; "*texto" lista os que combinam com o texto. A lista carrega em lotes ao rolar.
    // No toque, a busca vazia tambem mostra todos (o cardapio fica aberto).
    if (texto.trim().startsWith('*') || (toque && texto.trim() === '')) {
      const filtro = texto.trim().replace(/^\*/, '').trim();
      listaAtual.current = filtro;
      setTemMais(false);
      timerBusca.current = setTimeout(async () => {
        try {
          const lote = await api.get(`/products/search?q=${encodeURIComponent(filtro)}&limit=${LOTE}&offset=0&terminal_id=${terminalId}`);
          if (listaAtual.current !== filtro) return;
          setResults(lote);
          setTemMais(lote.length === LOTE);
        } catch (err) { toast.erro(err); }
      }, 180);
      return;
    }
    listaAtual.current = null;
    setTemMais(false);
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
  // Produto com complementos (adicionais, bebida do combo): abre a escolha antes; complementos = null quer dizer "ainda nao escolheu".
  function addToCart(product, quantidadeInformada = null, complementos = null) {
    if (complementos === null && product.grupos && product.grupos.length > 0) {
      setEscolhendo({ product, quantidade: quantidadeInformada });
      return true;
    }
    const comps = complementos || [];
    const fracionado = !UNIDADES_INTEIRAS.includes(product.unidade);
    const quantidade = quantidadeInformada ?? 1;
    if (!fracionado && !Number.isInteger(quantidade)) {
      toast.erro(`"${product.nome}" é vendido em ${product.unidade}: use quantidade inteira.`);
      return false;
    }
    const limite = limiteDe(product);
    // O limite vale para o total do produto (somando as linhas com observacoes diferentes).
    // Uma nova unidade entra na linha do produto que ainda nao tem observacao; senao abre uma linha nova.
    const doProduto = cart.filter((i) => i.id === product.id);
    const noCarrinho = doProduto.find((i) => !i.observacao && assinatura(i.complementos) === assinatura(comps));
    const novaQtd = doProduto.reduce((s, i) => s + i.quantidade, 0) + quantidade;
    if (novaQtd > limite) {
      toast.erro(msgSemEstoque(product, limite));
      return false;
    }
    const chave = noCarrinho ? noCarrinho.key : (doProduto.length === 0 ? product.id : `${product.id}#${proximaLinha.current++}`);
    setCart((prev) => {
      if (noCarrinho) {
        return prev.map((i) => (i.key === noCarrinho.key ? { ...i, quantidade: noCarrinho.quantidade + quantidade } : i));
      }
      return [...prev, {
        key: chave, id: product.id, nome: product.nome, unidade: product.unidade, preco_venda: Number(product.preco_venda) + precoComplementos(comps),
        quantidade, limite, tem_ficha_tecnica: product.tem_ficha_tecnica, insumo_limitante: product.insumo_limitante, observacao: '', complementos: comps,
      }];
    });
    // Produto por peso/volume adicionado sem quantidade: abre o campo para digitar o peso.
    if (fracionado && quantidadeInformada === null && !noCarrinho) {
      setTimeout(() => {
        setEditandoQtd((e) => ({ ...e, [chave]: '1' }));
        setTimeout(() => qtdRefs.current[chave]?.select(), 30);
      }, 0);
      return true;
    }
    focarBusca();
    return true;
  }

  async function carregarMais() {
    const filtro = listaAtual.current;
    if (filtro === null || !temMais || carregandoMais) return;
    setCarregandoMais(true);
    try {
      const lote = await api.get(`/products/search?q=${encodeURIComponent(filtro)}&limit=${LOTE}&offset=${results.length}&terminal_id=${terminalId}`);
      if (listaAtual.current !== filtro) return;
      setResults((atual) => [...atual, ...lote.filter((n) => !atual.some((a) => a.id === n.id))]);
      setTemMais(lote.length === LOTE);
    } catch (err) { toast.erro(err); } finally { setCarregandoMais(false); }
  }

  async function onBuscaKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelecionado((s) => Math.min(s + 1, results.length - 1));
      if (selecionado >= results.length - 3) carregarMais();
      return;
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelecionado((s) => Math.max(s - 1, 0)); return; }
    if (e.key === 'Escape') { setBusca(''); setResults([]); listaAtual.current = null; setTemMais(false); return; }
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
    if (!(nova > 0)) { removeItem(item.key); return; }
    if (UNIDADES_INTEIRAS.includes(item.unidade) && !Number.isInteger(nova)) {
      toast.erro(`"${item.nome}" só aceita quantidade inteira.`);
      return;
    }
    const outras = cart.filter((i) => i.id === item.id && i.key !== item.key).reduce((s, i) => s + i.quantidade, 0);
    if (outras + nova > item.limite) {
      toast.erro(msgSemEstoque(item, item.limite));
      return;
    }
    setCart((prev) => prev.map((i) => (i.key === item.key ? { ...i, quantidade: nova } : i)));
  }

  function confirmarQtdDigitada(item) {
    const valor = editandoQtd[item.key];
    setEditandoQtd((e) => { const c = { ...e }; delete c[item.key]; return c; });
    if (valor !== undefined) setQuantidade(item, valor);
    focarBusca();
  }

  function changeQty(item, delta) {
    setQuantidade(item, item.quantidade + delta);
  }

  function removeItem(key) {
    setCart((prev) => prev.filter((i) => i.key !== key));
    focarBusca();
  }

  function observar(key, texto) {
    setCart((prev) => prev.map((i) => (i.key === key ? { ...i, observacao: texto } : i)));
  }

  // Separa uma unidade numa linha propria (para dar uma observacao diferente a ela).
  function separarUnidade(item) {
    if (item.quantidade <= 1) return;
    const nova = { ...item, key: `${item.id}#${proximaLinha.current++}`, quantidade: 1, observacao: '' };
    setCart((prev) => {
      const pos = prev.findIndex((i) => i.key === item.key);
      const copia = prev.map((i) => (i.key === item.key ? { ...i, quantidade: i.quantidade - 1 } : i));
      copia.splice(pos + 1, 0, nova);
      return copia;
    });
  }

  async function cancelarVendaAtual() {
    if (cart.length === 0) return;
    if (await confirmar({ titulo: 'Cancelar esta venda?', mensagem: 'Todos os itens do carrinho serão removidos.', confirmar: 'Limpar carrinho', perigo: true })) {
      setCart([]);
    }
    focarBusca();
  }

  // Categorias da lista aberta (toque): filtro rapido por tipo de produto.
  const categorias = toque && listaAtual.current !== null ? [...new Set(results.map((p) => p.categoria).filter(Boolean))].sort() : [];
  const categoriaAtiva = categoria && categorias.includes(categoria) ? categoria : null;
  const visiveis = categoriaAtiva ? results.filter((p) => p.categoria === categoriaAtiva) : results;
  const subtotal = Number(cart.reduce((acc, i) => acc + i.preco_venda * i.quantidade, 0).toFixed(2));

  // ---------- pedido (lanchonete): o carrinho vira pedido em vez de venda imediata ----------
  const [lojas, setLojas] = useState([]);
  const [origemPdv, setOrigemPdv] = useState('balcao');
  const [pedidoModal, setPedidoModal] = useState(false);
  useEffect(() => { api.get('/locations').then(setLojas).catch(() => {}); }, []);
  const lojaDoTerminal = lojas.find((l) => terminal && l.id === terminal.location_id);
  const usaPedidos = !!(lojaDoTerminal && lojaDoTerminal.usa_pedidos) && podeAcessar(user, 'Pedidos');
  const temPreparo = cart.some((i) => i.tem_ficha_tecnica);
  // O carrinho so vira pedido quando tem produto que depende de preparo (receita/insumos): lanches. Esse carrinho
  // (inclusive misto, com bebida) vira pedido inteiro. Produto de pronta entrega sai sempre como venda direta.
  const modoPedido = usaPedidos && temPreparo;
  const rapido = modoPedido && origemPdv === 'balcao';

  // Cliente (so existe com produto de preparo no carrinho): telefone digitado, cadastro localizado e nome para chamar.
  const [clienteTel, setClienteTel] = useState('');
  const [clienteInfo, setClienteInfo] = useState(null);
  const telefoneNovo = clienteTel.replace(/\D/g, '').length >= 10 && !clienteInfo;
  const [nomeChamar, setNomeChamar] = useState('');
  const [mesaRapida, setMesaRapida] = useState('');
  const [cadastrarCliente, setCadastrarCliente] = useState(true);
  const [formaPed, setFormaPed] = useState('dinheiro');
  const [jaPagoPed, setJaPagoPed] = useState(false);
  const [recebidoPed, setRecebidoPed] = useState('');
  const [destinoRapido, setDestinoRapido] = useState('retirada');
  const [enderecoRapido, setEnderecoRapido] = useState('');
  const [taxaRapida, setTaxaRapida] = useState('5,00');
  const [comanda, setComanda] = useState(null);
  const [gerando, setGerando] = useState(false);
  useEffect(() => {
    if (!temPreparo) { setClienteTel(''); setClienteInfo(null); setNomeChamar(''); setMesaRapida(''); setDestinoRapido('retirada'); setEnderecoRapido(''); setFormaPed('dinheiro'); setJaPagoPed(false); setRecebidoPed(''); }
  }, [temPreparo]);

  useEffect(() => {
    if (destinoRapido === 'entrega' && clienteInfo && clienteInfo.enderecos.length > 0) {
      const padrao = clienteInfo.enderecos.find((e) => e.padrao) || clienteInfo.enderecos[0];
      setEnderecoRapido((atual) => atual || padrao.endereco);
    }
  }, [destinoRapido, clienteInfo]);

  // "Repetir ultimo pedido" (tela Clientes): carrinho e telefone chegam pela navegacao.
  const repetido = useRef(false);
  useEffect(() => {
    const rep = location.state && location.state.repetir;
    if (!rep || repetido.current || !terminalId) return;
    repetido.current = true;
    (async () => {
      try {
        if (rep.itens.length === 0) { if (rep.telefone) setClienteTel(rep.telefone); navigate('/pdv', { replace: true, state: null }); return; }
        const ids = rep.itens.map((i) => i.product_id).join(',');
        const prods = await api.get(`/products/search?ids=${ids}&terminal_id=${terminalId}`);
        const linhas = [];
        const faltou = [];
        rep.itens.forEach((i, idx) => {
          const p = prods.find((x) => x.id === i.product_id);
          const disp = p ? Number(p.saldo) : 0;
          const ja = linhas.filter((l) => l.id === i.product_id).reduce((t, l) => t + l.quantidade, 0);
          if (!p || disp - ja < Number(i.quantidade)) { faltou.push(i.nome); return; }
          linhas.push({
            key: `${p.id}#r${idx}`, id: p.id, nome: p.nome, unidade: p.unidade, quantidade: Number(i.quantidade),
            // Repete os complementos com o preco de hoje (os que sairam do cadastro ficam de fora).
            complementos: (i.complementos || []).map((c) => { const o = (p.grupos || []).flatMap((g) => g.opcoes).find((x) => x.id === c.id); return o ? { id: o.id, nome: o.nome, quantidade: Number(c.quantidade), preco: Number(o.preco) } : null; }).filter(Boolean),
            limite: disp, tem_ficha_tecnica: p.tem_ficha_tecnica, insumo_limitante: p.insumo_limitante, observacao: i.observacao || '',
          });
        });
        setCart(linhas.map((l) => ({ ...l, preco_venda: Number(prods.find((x) => x.id === l.id).preco_venda) + precoComplementos(l.complementos) })));
        if (rep.telefone) setClienteTel(rep.telefone);
        if (faltou.length > 0) toast.erro(`Sem estoque disponível, ficaram de fora: ${faltou.join(', ')}`);
        else toast.sucesso('Itens do último pedido no carrinho');
      } catch (err) { toast.erro(err); }
      navigate('/pdv', { replace: true, state: null });
    })();
  });

  async function pedidoCriado(pedido) {
    setPedidoModal(false);
    setCart([]);
    setClienteTel('');
    setClienteInfo(null);
    setNomeChamar(''); setCadastrarCliente(true);
    setMesaRapida('');
    setDestinoRapido('retirada');
    setEnderecoRapido('');
    setFormaPed('dinheiro');
    setJaPagoPed(false);
    setRecebidoPed('');
    toast.sucesso(`Pedido #${pedido.numero} gerado · estoque reservado${pedido.cliente_novo ? ' · cliente novo cadastrado' : ''}`);
    const cfg = configDaVenda(pedido);
    if (cfg.cozinha.ativo && cfg.cozinha.imprimir_automatico) abrirImpressao(setCupom, vendaDoPedido(pedido), 'cozinha', (m) => toast.sucesso(m));
    setComanda(pedido);
  }

  // Gera o pedido direto do carrinho (sem modal), com destino, cliente e pagamento. Telefone cadastrado vincula o cliente.
  const taxaPed = destinoRapido === 'entrega' ? Math.max(0, parseNumero(taxaRapida) || 0) : 0;
  const totalPed = subtotal + taxaPed;
  const recebidoNum = parseNumero(recebidoPed);
  const trocoPed = Number.isFinite(recebidoNum) ? recebidoNum - totalPed : null;
  async function gerarPedidoRapido() {
    if (cart.length === 0 || gerando) return;
    if (destinoRapido === 'mesa' && !mesaRapida.trim()) { toast.erro('Informe a mesa.'); return; }
    if (destinoRapido === 'entrega' && enderecoRapido.trim().length < 3) { toast.erro('Informe o endereço da entrega.'); return; }
    if (jaPagoPed && formaPed === 'dinheiro' && !(recebidoNum >= totalPed)) { toast.erro('Informe o valor recebido (igual ou maior que o total).'); return; }
    setGerando(true);
    try {
      const pedido = await api.post('/orders', {
        location_id: terminal.location_id, origem: origemPdv, tipo: destinoRapido,
        endereco: destinoRapido === 'mesa' ? 'Mesa ' + mesaRapida.trim().replace(/^mesa\s*/i, '') : destinoRapido === 'entrega' ? enderecoRapido.trim() : '',
        taxa_entrega: destinoRapido === 'entrega' ? Math.max(0, parseNumero(taxaRapida) || 0) : 0, cadastrar_cliente: cadastrarCliente,
        cliente_nome: nomeChamar.trim() || (clienteInfo ? clienteInfo.nome : ''), cliente_telefone: clienteInfo ? clienteInfo.telefone : clienteTel.replace(/\D/g, ''),
        forma_pagamento_prevista: formaPed, pago: jaPagoPed, valor_recebido: jaPagoPed && formaPed === 'dinheiro' ? recebidoNum : undefined,
        itens: cart.map((i) => ({ product_id: i.id, quantidade: i.quantidade, observacao: i.tem_ficha_tecnica ? (i.observacao || '').trim() : '', complementos: (i.complementos || []).map((c) => ({ id: c.id, quantidade: c.quantidade })) })),
      });
      await pedidoCriado(pedido);
    } catch (err) { toast.erro(err); } finally { setGerando(false); }
  }

  function fecharComanda(imprimir) {
    if (imprimir && comanda) {
      const venda = vendaDoPedido(comanda);
      abrirImpressao(setCupom, venda, configDaVenda(venda).cozinha.ativo ? 'cozinha' : 'cliente', (m) => toast.sucesso(m));
    }
    setComanda(null);
    focarBusca();
  }

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
    if (modoPedido) { gerarPedidoRapido(); return; }
    setFormaPagamento(null);
    setValorRecebido('');
    setDescontoTexto('');
    setDescontoTipo('valor');
    setPagamentoAberto(true);
    buscaRef.current?.blur();
  }

  function escolherForma(f) {
    setFormaPagamento(f);
    if (f === 'dinheiro' && !toque) setTimeout(() => recebidoRef.current?.focus(), 0);
  }

  async function finalizarVenda() {
    if (!podeConfirmar) return;
    setEnviando(true);
    try {
      const payload = {
        terminal_id: terminalId,
        itens: cart.map((i) => ({ product_id: i.id, quantidade: i.quantidade, observacao: i.tem_ficha_tecnica ? (i.observacao || '').trim() : undefined, complementos: (i.complementos || []).map((c) => ({ id: c.id, quantidade: c.quantidade })) })),
        forma_pagamento: formaPagamento,
        desconto,
      };
      if (formaPagamento === 'dinheiro') payload.valor_recebido = recebido;
      const venda = await api.post('/sales', payload);
      setSucesso(venda);
      setSucessoCompleta(null);
      setUltimaVendaId(venda.id);
      // Dados completos (config do cupom da loja) para imprimir; imprime sozinho se a loja configurou.
      api.get(`/sales/${venda.id}`).then((completa) => {
        setSucessoCompleta(completa);
        const modo = modoAutomatico(completa);
        if (modo) abrirImpressao(setCupom, completa, modo, (m) => toast.sucesso(m));
      }).catch(() => {});
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
  const [sucessoCompleta, setSucessoCompleta] = useState(null);
  const [ultimaVendaId, setUltimaVendaId] = useState(null);
  const [cupom, setCupom] = useState(null);

  async function imprimirCupom(vendaId, modo = 'cliente') {
    try {
      abrirImpressao(setCupom, await api.get(`/sales/${vendaId}`), modo, (m) => toast.sucesso(m));
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

  // Sai do modo PDV (a mesma saida do botao "Sair do PDV"); com itens no carrinho pede confirmacao.
  async function sairDoPdv() {
    if (cart.length > 0 && !(await confirmar({ titulo: 'Sair do PDV?', mensagem: 'O carrinho tem itens que serão perdidos.', confirmar: 'Sair do PDV', perigo: true }))) { focarBusca(); return; }
    const destino = telasDoUsuario(user).filter((t) => t.path !== '/pdv')[0];
    navigate(destino ? destino.path : '/inicio');
  }

  // ---------- atalhos de teclado ----------
  const algumModal = pagamentoAberto || !!sucesso || movModalAberto || fecharAberto || pedidoModal || !!comanda;
  useEffect(() => {
    if (!session) return undefined;
    function onKey(e) {
      if (comanda) {
        if (e.key === 'Enter') { e.preventDefault(); fecharComanda(true); }
        if (e.key === 'Escape') { e.preventDefault(); fecharComanda(false); }
        return;
      }
      if (sucesso) {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); novaVenda(); }
        if (e.key.toLowerCase() === 'p' || e.key === 'F9') { e.preventDefault(); imprimirCupom(sucesso.id); }
        if (e.key.toLowerCase() === 'c' && sucessoCompleta && configDaVenda(sucessoCompleta).cozinha.ativo) { e.preventDefault(); imprimirCupom(sucesso.id, 'cozinha'); }
        if (e.key.toLowerCase() === 's' && sucessoCompleta && configDaVenda(sucessoCompleta).senha.ativo) { e.preventDefault(); imprimirCupom(sucesso.id, 'senha'); }
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
      if (e.key === 'F4') { e.preventDefault(); if (podeSangria) setMovModalAberto(true); }
      if (e.key === 'F6') { e.preventDefault(); cancelarVendaAtual(); }
      if (e.key === 'F8') { e.preventDefault(); if (podeFechar) setFecharAberto(true); }
      if (e.key === 'F9' && ultimaVendaId) { e.preventDefault(); imprimirCupom(ultimaVendaId); }
      // Esc: limpa a busca; com a busca ja vazia, sai do modo PDV.
      if (e.key === 'Escape') {
        e.preventDefault();
        if (busca || results.length > 0) { setBusca(''); setResults([]); listaAtual.current = null; setTemMais(false); } else sairDoPdv();
      }
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
          {podeSangria && <button onClick={() => setMovModalAberto(true)}>Sangria/Suprimento <kbd>F4</kbd></button>}
          {ultimaVendaId && <button onClick={() => imprimirCupom(ultimaVendaId)}>Reimprimir cupom <kbd>F9</kbd></button>}
          {podeFechar && <button onClick={() => setFecharAberto(true)}>Fechar caixa <kbd>F8</kbd></button>}
        </div>
      </div>

      <div className="pdv-body">
        <div className="pdv-busca">
          <div className="pdv-campo-wrap">
          <input
            ref={buscaRef}
            className="pdv-campo"
            placeholder={toque ? 'Buscar produto pelo nome ou código' : 'Código de barras ou nome do produto  ·  3*código para quantidade  ·  * lista todos'}
            value={busca}
            onChange={(e) => onBuscaChange(e.target.value)}
            onKeyDown={onBuscaKeyDown}
            enterKeyHint="search"
            // Nao e formulario: sem sugestao de senha/cartao/endereco do navegador nem corretor por cima da lista
            name="pdv-busca-produto"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            onFocus={() => {
              setBuscaFocada(true);
              // Toque: o teclado ocupa metade da tela; sobe a busca para o topo para a lista caber acima dele.
              if (toque) setTimeout(() => { const el = buscaRef.current; if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 8 }); }, 300);
            }}
            onBlur={() => setBuscaFocada(false)}
            autoFocus={!toque}
            aria-label="Buscar produto"
          />
          {toque && busca && (
            <button type="button" className="pdv-limpar-busca" aria-label="Limpar a busca" onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setCategoria(null); onBuscaChange(''); }}>×</button>
          )}
          </div>
          {toque && categorias.length > 1 && (
            <div className="pdv-categorias" role="tablist" aria-label="Categorias">
              <button type="button" role="tab" aria-selected={!categoriaAtiva} className={!categoriaAtiva ? 'on' : ''} onClick={() => setCategoria(null)}>Todos</button>
              {categorias.map((c) => <button type="button" role="tab" key={c} aria-selected={categoriaAtiva === c} className={categoriaAtiva === c ? 'on' : ''} onClick={() => setCategoria(c)}>{c}</button>)}
            </div>
          )}
          {results.length > 0 && (
            <div className={`resultados-lista ${toque ? 'toque' : ''}`}>
              <div className="resultados-cab" aria-hidden="true">
                <span />
                <span>Produto</span>
                <span>Código</span>
                <span>Categoria</span>
                <span className="num">Estoque</span>
                <span className="num">Preço</span>
              </div>
              <ul className="resultados" role="listbox" aria-label="Produtos encontrados"
                onScroll={(e) => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) carregarMais(); }}>
                {visiveis.map((p, i) => {
                  const semEstoque = Number(p.saldo) <= 0;
                  const noCarrinho = cart.filter((c) => c.id === p.id).reduce((t, c) => t + c.quantidade, 0);
                  return (
                    <li key={p.id} ref={i === selecionado ? itemSelecionadoRef : null} role="option" aria-selected={i === selecionado}
                      className={`${i === selecionado ? 'selecionado' : ''} ${semEstoque ? 'sem-estoque' : ''}`}
                      onMouseMove={() => { if (i !== selecionado) setSelecionado(i); }} onClick={() => { if (addToCart(p) && !toque) { setBusca(''); setResults([]); } }}>
                      <span className="resultado-seta">{i === selecionado ? '▶' : ''}</span>
                      <span className="resultado-nome">{p.nome}{noCarrinho > 0 && <span className="no-carrinho" aria-label={`${qtd(noCarrinho, p.unidade)} no carrinho`}>{qtd(noCarrinho, p.unidade)}</span>}</span>
                      <span className="resultado-codigo">{p.codigo_interno}<small>{p.barcode}</small></span>
                      <span className="resultado-cat">{p.categoria || '—'}</span>
                      <span className="saldo-pdv num">{semEstoque ? (p.tem_ficha_tecnica ? `sem estoque: falta ${p.insumo_limitante || 'insumo'}` : `sem estoque${p.em_outras_lojas ? ' (há em outra loja)' : ''}`) : p.tem_ficha_tecnica ? `dá para ${p.saldo} un.` : qtd(p.saldo, p.unidade)}</span>
                      <span className="resultado-preco num">{brl(p.preco_venda)}{p.unidade !== 'UN' ? ` / ${p.unidade}` : ''}</span>
                    </li>
                  );
                })}
                {listaAtual.current !== null && (
                  <li className="resultados-rodape" aria-hidden={!toque || !temMais} onClick={() => { if (temMais) carregarMais(); }}>
                    {carregandoMais ? 'Carregando mais produtos...' : temMais ? (toque ? 'Toque para carregar mais' : 'Role ou use ↓ para carregar mais') : `Fim da lista · ${visiveis.length} produto(s)`}
                  </li>
                )}
              </ul>
            </div>
          )}
          <div className="atalhos">
            <span><kbd>Enter</kbd> adiciona</span>
            <span><kbd>↑</kbd><kbd>↓</kbd> percorre a lista</span>
            <span><kbd>3*</kbd> quantidade</span>
            <span><kbd>*</kbd> lista todos os produtos</span>
            <span><kbd>Del</kbd> tira o último</span>
            <span><kbd>F2</kbd> pagamento</span>
            <span><kbd>F6</kbd> cancelar venda</span>
            <span><kbd>Esc</kbd> limpa a busca / sai do PDV</span>
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
              <div key={i.key} className="carrinho-item">
                <div className="carrinho-info">
                  <span className="carrinho-nome">{i.nome}</span>
                  {i.complementos && i.complementos.length > 0 && <span className="carrinho-comps">{textoComplementos(i.complementos)}</span>}
                  <span className="muted">{qtd(i.quantidade, i.unidade)} {i.unidade} × {brl(i.preco_venda)}</span>
                </div>
                <div className="carrinho-qtd">
                  <button type="button" aria-label="Diminuir" onClick={() => changeQty(i, -1)} disabled={!UNIDADES_INTEIRAS.includes(i.unidade) && i.quantidade <= 1}>−</button>
                  <input
                    ref={(el) => { qtdRefs.current[i.key] = el; }}
                    inputMode="decimal"
                    aria-label={`Quantidade de ${i.nome}`}
                    value={editandoQtd[i.key] ?? qtd(i.quantidade, i.unidade)}
                    onFocus={(e) => { setEditandoQtd((x) => ({ ...x, [i.key]: qtd(i.quantidade, i.unidade) })); setTimeout(() => e.target.select(), 0); }}
                    onChange={(e) => setEditandoQtd((x) => ({ ...x, [i.key]: e.target.value }))}
                    onBlur={() => confirmarQtdDigitada(i)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }}
                  />
                  <button type="button" aria-label="Aumentar" onClick={() => changeQty(i, 1)}>+</button>
                </div>
                <span className="carrinho-subtotal">{brl(i.preco_venda * i.quantidade)}</span>
                <button type="button" className="carrinho-remover" aria-label={`Remover ${i.nome}`} onClick={() => removeItem(i.key)}>×</button>
                {i.tem_ficha_tecnica && (
                  <div className="carrinho-obs">
                    <textarea rows={1} maxLength={200} aria-label={`Observação de ${i.nome}`} placeholder={toque ? 'Observação (ex.: sem cebola)' : 'Observação do pedido (ex.: sem milho, sem cebola)'}
                      value={i.observacao || ''} onChange={(e) => observar(i.key, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); focarBusca(); } }} />
                    {i.quantidade > 1 && <button type="button" className="btn-link" onClick={() => separarUnidade(i)}>Separar 1 un. com outra observação</button>}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="carrinho-total">
            <span>Total</span>
            <strong>{brl(subtotal)}</strong>
          </div>
          {temPreparo && usaPedidos && (
            <div className="cli-pdv">
              <ClienteTelefone telefone={clienteTel} onTelefone={setClienteTel} cliente={clienteInfo} onCliente={setClienteInfo}
                dica={rapido ? 'O pedido sai no nome deste cliente.' : 'Nome e endereço serão preenchidos no pedido.'}
                textoNovo="Telefone não cadastrado: será criado ao gerar o pedido, com o nome e o endereço informados." />
              {!clienteInfo && (
                <label className="field"><span className="field-label">{rapido ? 'Nome para chamar (opcional)' : 'Nome do cliente (opcional)'}</span>
                  <input value={nomeChamar} maxLength={60} onChange={(e) => setNomeChamar(e.target.value)} placeholder="Ex.: João"
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }} />
                </label>
              )}
              {telefoneNovo && (
                <label className="cli-check"><input type="checkbox" checked={cadastrarCliente} onChange={(e) => setCadastrarCliente(e.target.checked)} /> Cadastrar este cliente</label>
              )}
              {(
                <div className="field"><span className="field-label">Destino</span>
                  <div className="ped-seg2">
                    <button type="button" className={destinoRapido === 'retirada' ? 'on' : ''} onClick={() => setDestinoRapido('retirada')}>🛍 Retirada</button>
                    <button type="button" className={destinoRapido === 'entrega' ? 'on' : ''} onClick={() => setDestinoRapido('entrega')}>🛵 Entrega</button>
                    <button type="button" className={destinoRapido === 'mesa' ? 'on' : ''} onClick={() => setDestinoRapido('mesa')}>🍽 Mesa</button>
                  </div>
                </div>
              )}
              {destinoRapido === 'mesa' && (
                <label className="field"><span className="field-label">Mesa</span>
                  <input value={mesaRapida} maxLength={30} onChange={(e) => setMesaRapida(e.target.value)} placeholder="Número ou nome da mesa"
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }} />
                </label>
              )}
              {destinoRapido === 'entrega' && (
                <>
                  <label className="field"><span className="field-label">Endereço da entrega</span>
                    <input value={enderecoRapido} maxLength={300} onChange={(e) => setEnderecoRapido(e.target.value)} placeholder="Rua, nº, bairro" /></label>
                  <label className="field"><span className="field-label">Taxa de entrega (R$)</span>
                    <input value={taxaRapida} onChange={(e) => setTaxaRapida(e.target.value)} inputMode="decimal" /></label>
                </>
              )}
            </div>
          )}
          {modoPedido && (
            <>
              <div className="pedido-pdv-aviso" style={{ border: 'none', background: 'none', padding: '8px 0 0' }}>
                <span className="field-label">Origem do pedido</span>
                <div className="ped-seg2" style={{ marginTop: 6 }}>
                  {ORIGENS.map((o) => <button type="button" key={o.id} className={origemPdv === o.id ? 'on' : ''} onClick={() => setOrigemPdv(o.id)}>{o.nome}</button>)}
                </div>
                <div style={{ marginTop: 6 }}>{toque ? 'Gerar pedido' : 'F2'} reserva o estoque e mostra a comanda.</div>
              </div>
            </>
          )}
          {modoPedido && (
            <div className="cli-pdv">
              <label className="field"><span className="field-label">Pagamento</span>
                <select value={formaPed} onChange={(e) => setFormaPed(e.target.value)}>{PAGAMENTOS.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}</select>
              </label>
              <label className="cli-check"><input type="checkbox" checked={jaPagoPed} onChange={(e) => setJaPagoPed(e.target.checked)} /> Já pago (pagamento antecipado)</label>
              {jaPagoPed && formaPed === 'dinheiro' && (
                <>
                  <label className="field"><span className="field-label">Valor recebido (R$)</span>
                    <input value={recebidoPed} onChange={(e) => setRecebidoPed(e.target.value)} inputMode="decimal" placeholder="0,00" /></label>
                  <div className="ped-linha"><span>Troco</span><b style={{ color: trocoPed !== null && trocoPed >= 0 ? 'var(--ok)' : 'var(--err)' }}>{trocoPed === null ? '—' : trocoPed >= 0 ? brl(trocoPed) : 'valor insuficiente'}</b></div>
                </>
              )}
              {taxaPed > 0 && <div className="ped-linha"><span>Taxa de entrega</span><span>{brl(taxaPed)}</span></div>}
              {taxaPed > 0 && <div className="ped-linha ped-total"><span>Total do pedido</span><b>{brl(totalPed)}</b></div>}
            </div>
          )}
          <button ref={finalizarRef} className="btn-finalizar" disabled={cart.length === 0 || gerando} onClick={abrirPagamento}>{modoPedido ? 'Gerar pedido' : 'Finalizar venda'} <kbd>F2</kbd></button>
        </div>
      </div>

      {cart.length > 0 && !finalizarVisivel && !buscaFocada && (
        <div className="pdv-barra-movel">
          <div><span className="muted">{cart.reduce((t, i) => t + (UNIDADES_INTEIRAS.includes(i.unidade) ? i.quantidade : 1), 0)} item(ns)</span><strong>{brl(subtotal)}</strong></div>
          <button type="button" className="btn-primario" onClick={() => finalizarRef.current?.scrollIntoView({ block: 'center' })}>{modoPedido ? 'Ver pedido' : 'Ver carrinho'}</button>
        </div>
      )}

      {pedidoModal && terminal && (
        <PedidoForm lojaId={terminal.location_id} origemInicial={origemPdv} titulo="Gerar pedido" telefoneInicial={clienteTel} nomeInicial={nomeChamar.trim() || (clienteInfo ? clienteInfo.nome : '')}
          tipoInicial={destinoRapido} enderecoInicial={destinoRapido === 'entrega' ? enderecoRapido : ''} taxaInicial={taxaRapida} mesaInicial={mesaRapida} cadastrarInicial={cadastrarCliente} onClose={() => setPedidoModal(false)} onCriado={pedidoCriado}
          itensIniciais={cart.map((i) => ({ key: i.key, product_id: i.id, nome: i.nome, unidade: i.unidade, preco: i.preco_venda, quantidade: i.quantidade, observacao: i.tem_ficha_tecnica ? (i.observacao || '').trim() : '', tem_ficha: !!i.tem_ficha_tecnica, limite: i.limite, complementos: i.complementos || [] }))} />
      )}

      {comanda && (
        <Modal titulo="Comanda gerada" subtitulo="Impressão para a cozinha e via do cliente" onClose={() => fecharComanda(false)}>
          <div className="comanda-previa">
            <div className="cp-loja">{comanda.location_nome || 'Lanchonete'}</div>
            <div className="cp-numero">PEDIDO #{comanda.numero}</div>
            <div className="cp-centro">{NOME_ORIGEM[comanda.origem] || comanda.origem}{comanda.cliente_nome ? ` · ${comanda.cliente_nome}` : ''}</div>
            {comanda.tipo === 'mesa' && <div className="cp-numero cp-mesa">{(comanda.endereco || 'MESA').toUpperCase()}</div>}
            {comanda.tipo === 'entrega' && comanda.endereco && <div className="cp-centro">ENTREGA · {comanda.endereco}</div>}
            <div className="cp-centro cp-pequeno">{dataHora(comanda.criado_em)}</div>
            <hr />
            {comanda.itens.map((i) => <div key={i.id || i.product_id}>{qtd(i.quantidade, i.unidade)}x {i.product_nome || i.nome}{i.complementos && i.complementos.length > 0 ? <div className="cp-obs">{textoComplementos(i.complementos)}</div> : null}{i.observacao ? <div className="cp-obs">Obs.: {i.observacao}</div> : null}</div>)}
            {comanda.observacao && <div className="cp-obs" style={{ marginTop: 8 }}>OBS: {comanda.observacao}</div>}
            <hr />
            <div className="cp-total"><span>TOTAL</span><b>{brl(comanda.total)}</b></div>
            <div className="cp-centro">{comanda.pago ? 'PAGO' : comanda.tipo === 'mesa' ? 'A PAGAR NA MESA' : comanda.tipo === 'entrega' ? 'A PAGAR NA ENTREGA' : 'A PAGAR NA RETIRADA'}</div>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => { const n = comanda.id; setComanda(null); navigate('/pedidos', { state: { abrir: n } }); }}>Ver em Pedidos</button>
            <button type="button" autoFocus onClick={() => fecharComanda(true)}>🖨 Imprimir e continuar vendendo <kbd>Enter</kbd></button>
          </div>
        </Modal>
      )}

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
            {podeDesconto && <Field label="Desconto">
              <div className="input-com-seletor">
                <input inputMode="decimal" placeholder="0" value={descontoTexto} onChange={(e) => setDescontoTexto(e.target.value)} />
                <select value={descontoTipo} onChange={(e) => setDescontoTipo(e.target.value)} aria-label="Tipo de desconto">
                  <option value="valor">R$</option>
                  <option value="percentual">%</option>
                </select>
              </div>
            </Field>}
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
          {sucesso.numero_pedido !== null && sucesso.numero_pedido !== undefined && (
            <div className="pedido-destaque"><span>PEDIDO</span><strong>Nº {sucesso.numero_pedido}</strong></div>
          )}
          <div className="pagamento-resumo">
            <div><span>Forma</span><span>{FORMA_PAGAMENTO[sucesso.forma_pagamento]}</span></div>
            {Number(sucesso.desconto) > 0 && <div><span>Desconto</span><span>− {brl(sucesso.desconto)}</span></div>}
            <div className="pagamento-total"><span>Total</span><strong>{brl(sucesso.total)}</strong></div>
            {sucesso.troco !== null && <div className="troco destaque"><span>Troco</span><strong>{brl(sucesso.troco)}</strong></div>}
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => imprimirCupom(sucesso.id)}>Imprimir cupom <kbd>P</kbd></button>
            {sucessoCompleta && configDaVenda(sucessoCompleta).cozinha.ativo && (
              <button type="button" onClick={() => imprimirCupom(sucesso.id, 'cozinha')}>Comanda da cozinha <kbd>C</kbd></button>
            )}
            {sucessoCompleta && configDaVenda(sucessoCompleta).senha.ativo && (
              <button type="button" onClick={() => imprimirCupom(sucesso.id, 'senha')}>Senha do cliente <kbd>S</kbd></button>
            )}
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

      {escolhendo && (
        <EscolherComplementos produto={escolhendo.product} onClose={() => { setEscolhendo(null); focarBusca(); }}
          onConfirmar={(comps) => { const e = escolhendo; setEscolhendo(null); addToCart(e.product, e.quantidade, comps); }} />
      )}
      {cupom && <Cupom venda={cupom} />}
    </div>
  );
}

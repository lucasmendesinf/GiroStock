import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, definirSessao } from './api';
import { aplicarTema, chaveItem } from './util';

const Ctx = createContext(null);
export const useLoja = () => useContext(Ctx);

// Guardado no navegador por loja (na pre-visualizacao varias lojas dividem o mesmo endereco).
const ler = (k, padrao) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : padrao; } catch { return padrao; } };
const gravar = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };

export function ProvedorLoja({ children }) {
  const [loja, setLoja] = useState(null);
  const [erroLoja, setErroLoja] = useState(null);
  const [sessao, setSessao] = useState(null); // { token, conta }
  const [carrinho, setCarrinho] = useState([]);
  const [avisos, setAvisos] = useState([]);
  const pronto = useRef(false);

  const avisar = useCallback((texto, tipo = 'ok') => {
    const id = Math.random();
    setAvisos((l) => [...l, { id, texto, tipo }]);
    setTimeout(() => setAvisos((l) => l.filter((a) => a.id !== id)), tipo === 'erro' ? 6000 : 3500);
  }, []);

  const sair = useCallback(() => {
    setSessao(null);
    definirSessao(null);
  }, []);

  const carregarLoja = useCallback(() => api.get('/loja').then((l) => {
    setLoja(l);
    aplicarTema(l.tema, l.nome);
    return l;
  }), []);

  useEffect(() => {
    carregarLoja().then((l) => {
      const s = ler(`lv_sessao_${l.id}`, null);
      if (s && s.token) { definirSessao(s.token, () => { sair(); avisar('Sua sessão expirou. Entre de novo.', 'erro'); }); setSessao(s); }
      setCarrinho(ler(`lv_carrinho_${l.id}`, []));
      pronto.current = true;
    }).catch((err) => setErroLoja(err));
    const t = setInterval(() => { carregarLoja().catch(() => {}); }, 120000); // horario/pausa atualizados
    return () => clearInterval(t);
  }, [carregarLoja, sair, avisar]);

  useEffect(() => { if (loja && pronto.current) gravar(`lv_carrinho_${loja.id}`, carrinho); }, [carrinho, loja]);
  useEffect(() => { if (loja && pronto.current) gravar(`lv_sessao_${loja.id}`, sessao); }, [sessao, loja]);

  const entrar = useCallback((r) => {
    definirSessao(r.token, () => { sair(); avisar('Sua sessão expirou. Entre de novo.', 'erro'); });
    setSessao({ token: r.token, conta: r.conta });
  }, [sair, avisar]);
  const atualizarConta = useCallback((conta, token) => {
    if (token) definirSessao(token);
    setSessao((s) => ({ token: token || s.token, conta: conta || s.conta }));
  }, []);

  const adicionar = useCallback((item) => {
    setCarrinho((l) => {
      const k = chaveItem(item);
      const ja = l.find((x) => chaveItem(x) === k);
      if (ja) return l.map((x) => (x === ja ? { ...x, quantidade: Math.min(x.quantidade + item.quantidade, item.maximo || 99) } : x));
      return [...l, item];
    });
  }, []);
  const mudarQuantidade = useCallback((k, q) => setCarrinho((l) => (q <= 0 ? l.filter((x) => chaveItem(x) !== k) : l.map((x) => (chaveItem(x) === k ? { ...x, quantidade: q } : x)))), []);
  const esvaziar = useCallback(() => setCarrinho([]), []);

  const valor = useMemo(() => ({
    loja, erroLoja, carregarLoja, sessao, conta: sessao && sessao.conta, entrar, sair, atualizarConta,
    carrinho, adicionar, mudarQuantidade, esvaziar,
    quantidadeCarrinho: carrinho.reduce((s, i) => s + (Number.isInteger(i.quantidade) ? i.quantidade : 1), 0),
    totalCarrinho: carrinho.reduce((s, i) => s + i.preco_unitario * i.quantidade, 0),
    avisar, avisos,
  }), [loja, erroLoja, carregarLoja, sessao, entrar, sair, atualizarConta, carrinho, adicionar, mudarQuantidade, esvaziar, avisar, avisos]);
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// Avisos (toast fixo no canto da tela) e confirmacoes para acoes destrutivas.
const UiContext = createContext(null);

export function UiProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [confirmacao, setConfirmacao] = useState(null);
  const [alertaCusto, setAlertaCusto] = useState(null);
  const proximoId = useRef(1);

  const remover = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const mostrar = useCallback((tipo, texto) => {
    const id = proximoId.current++;
    const mensagem = String(texto || '').replace(/^./, (c) => c.toUpperCase());
    setToasts((t) => [...t.slice(-3), { id, tipo, mensagem }]);
    setTimeout(() => remover(id), tipo === 'erro' ? 7000 : 4000);
  }, [remover]);

  const toast = useRef({});
  toast.current.sucesso = (m) => mostrar('ok', m);
  toast.current.custoAcimaVenda = (lista) => setAlertaCusto(lista);
  toast.current.erro = (m) => mostrar('erro', m instanceof Error ? m.message : m);

  // confirmar({ titulo, mensagem, confirmar: 'Desativar', perigo: true }) => Promise<boolean>
  const confirmar = useCallback((opcoes) => new Promise((resolve) => {
    setConfirmacao({ ...opcoes, resolve });
  }), []);

  function responder(valor) {
    confirmacao.resolve(valor);
    setConfirmacao(null);
  }

  return (
    <UiContext.Provider value={{ toast: toast.current, confirmar }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tipo}`} onClick={() => remover(t.id)}>{t.mensagem}</div>
        ))}
      </div>
      {alertaCusto && <AlertaCusto lista={alertaCusto} onFechar={() => setAlertaCusto(null)} />}
      {confirmacao && <ConfirmDialog {...confirmacao} onResponder={responder} />}
    </UiContext.Provider>
  );
}

// Popup: produtos cujo custo (soma dos insumos) ficou igual ou acima do preco de venda.
function AlertaCusto({ lista, onFechar }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onFechar(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onFechar]);
  const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return (
    <div className="modal" role="alertdialog" aria-modal="true" style={{ zIndex: 90 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar(); }}>
      <div className="modal-content wide">
        <div className="modal-header">
          <div>
            <h3>Custo acima do preço de venda</h3>
            <div className="modal-subtitle">O custo foi atualizado pela última entrada, mas estes produtos passaram a vender abaixo do custo.</div>
          </div>
          <button type="button" className="modal-close" aria-label="Fechar aviso" onClick={onFechar}>×</button>
        </div>
        <ul className="lista-simples">
          {lista.map((p) => (
            <li key={p.nome}>
              <strong>{p.nome}</strong>
              <span>custo {brl(p.preco_custo)} · venda {brl(p.preco_venda)}</span>
            </li>
          ))}
        </ul>
        <div className="modal-actions"><button type="button" onClick={onFechar}>Entendi</button></div>
      </div>
    </div>
  );
}

function ConfirmDialog({ titulo, mensagem, confirmar, perigo, onResponder }) {
  const botaoRef = useRef(null);
  useEffect(() => {
    botaoRef.current?.focus();
    function onKey(e) { if (e.key === 'Escape') onResponder(false); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onResponder]);
  return (
    <div className="modal" role="dialog" aria-modal="true" style={{ zIndex: 80 }}>
      <div className="modal-content">
        <h3>{titulo || 'Confirmar'}</h3>
        {mensagem && <p style={{ margin: 0, lineHeight: 1.5 }}>{mensagem}</p>}
        <div className="modal-actions">
          <button type="button" onClick={() => onResponder(false)}>Voltar</button>
          <button type="button" ref={botaoRef} className={perigo ? 'perigo' : ''} onClick={() => onResponder(true)}>{confirmar || 'Confirmar'}</button>
        </div>
      </div>
    </div>
  );
}

export function useToast() {
  return useContext(UiContext).toast;
}

export function useConfirm() {
  return useContext(UiContext).confirmar;
}

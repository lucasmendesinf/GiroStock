import { useEffect, useRef, useState } from 'react';
import { destravarSom, ligarSom, somLigado, tocarSomPedido } from '../utils/somPedidos';

// Botao "Som dos pedidos" (telas de pedidos): liga/desliga o som neste aparelho, testa o som de cada origem e
// pede permissao para avisar com a aba minimizada.
export default function SomPedidosControle() {
  const [ligado, setLigado] = useState(somLigado);
  const [aberto, setAberto] = useState(false);
  const [permissao, setPermissao] = useState(() => ('Notification' in window ? Notification.permission : 'indisponivel'));
  const ref = useRef(null);
  useEffect(() => {
    const atualizar = () => setLigado(somLigado());
    window.addEventListener('girostock:som-pedidos', atualizar);
    const fora = (e) => { if (ref.current && !ref.current.contains(e.target)) setAberto(false); };
    document.addEventListener('pointerdown', fora);
    return () => { window.removeEventListener('girostock:som-pedidos', atualizar); document.removeEventListener('pointerdown', fora); };
  }, []);
  const testar = (o) => destravarSom().then(() => tocarSomPedido(o, { forcar: true }));
  async function pedirPermissao() {
    try { setPermissao(await Notification.requestPermission()); } catch { /* sem suporte */ }
  }
  return (
    <div className="som-pedidos" ref={ref}>
      <button type="button" className="btn-link" aria-expanded={aberto} onClick={() => setAberto(!aberto)}>{ligado ? '🔔' : '🔕'} Som dos pedidos</button>
      {aberto && (
        <div className="som-pedidos-menu">
          <label className="check"><input type="checkbox" checked={ligado} onChange={(e) => { ligarSom(e.target.checked); setLigado(e.target.checked); }} /> Tocar som quando chegar pedido (neste aparelho)</label>
          <div className="som-pedidos-testes">
            <span>Testar:</span>
            <button type="button" className="aviso-teste origem-loja_virtual" onClick={() => testar('loja_virtual')}>Loja virtual</button>
            <button type="button" className="aviso-teste origem-ifood" onClick={() => testar('ifood')}>iFood</button>
            <button type="button" className="aviso-teste origem-99food" onClick={() => testar('99food')}>99Food</button>
          </div>
          {permissao === 'default' && <button type="button" className="btn-link" onClick={pedirPermissao}>Avisar também com a aba minimizada</button>}
          {permissao === 'granted' && <small className="muted">Aviso com a aba minimizada: ligado.</small>}
          {permissao === 'denied' && <small className="muted">O navegador bloqueou os avisos com a aba minimizada (libere no cadeado da barra de endereço).</small>}
          <small className="muted">O som repete a cada 30 s enquanto houver pedido novo sem aceitar.</small>
        </div>
      )}
    </div>
  );
}

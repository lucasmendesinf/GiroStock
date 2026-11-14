import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { brl } from '../utils/format';
import { destravarSom, somLiberado, tocarSomPedido } from '../utils/somPedidos';

// Aviso de pedido novo em qualquer tela: cartao na lateral (como mensagem chegando no WhatsApp) e som proprio de cada
// origem (loja virtual, iFood, 99Food). Busca sozinho a cada 10 s (sem atualizar a pagina). O som repete a cada 30 s
// enquanto houver pedido novo nao aceito; para quando o pedido e aceito, quando o cartao e aberto ou fechado.
// Montado uma vez na raiz do app (nao reinicia ao trocar de tela).
const INTERVALO_MS = 10000;
const REPETIR_MS = 30000;
const CHAVE_DISPENSADOS = 'girostock_avisos_dispensados';
const NOME = { ifood: 'iFood', '99food': '99Food', loja_virtual: 'Loja virtual' };
const ORDEM_SOM = ['ifood', '99food', 'loja_virtual'];

function lerDispensados() {
  try { return new Set(JSON.parse(sessionStorage.getItem(CHAVE_DISPENSADOS) || '[]')); } catch { return new Set(); }
}
function gravarDispensados(s) {
  try { sessionStorage.setItem(CHAVE_DISPENSADOS, JSON.stringify([...s].slice(-200))); } catch { /* sem armazenamento */ }
}

// Relogio que nao e "congelado" quando a aba fica em segundo plano: o navegador segura setInterval de abas escondidas
// (ate 1 vez por minuto); num Web Worker o intervalo continua normal.
function criarRelogio(fn, ms) {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = fn;
    return () => { w.terminate(); URL.revokeObjectURL(url); };
  } catch {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }
}

const quandoChegou = (iso, agora) => {
  const min = Math.max(0, Math.floor((agora - new Date(iso).getTime()) / 60000));
  return min < 1 ? 'agora' : `há ${min} min`;
};

export default function AvisoPedidos() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const ativo = !!user && !user.deveTrocarSenha && !user.master && user.perfil !== 'Garçom' && !!(user.areas && (user.areas.Pedidos || user.areas.LojaVirtual));
  const [pedidos, setPedidos] = useState([]);
  const [dispensados, setDispensados] = useState(lerDispensados);
  const [semSom, setSemSom] = useState(false); // ha pedido e o navegador ainda nao liberou o som
  const [agora, setAgora] = useState(Date.now());
  const conhecidos = useRef(null);
  const ultimoSom = useRef(0);
  const dispensadosRef = useRef(dispensados);
  dispensadosRef.current = dispensados;

  // O navegador so libera audio depois de um clique ou tecla na pagina.
  useEffect(() => {
    const liberar = () => { destravarSom().then(() => setSemSom(false)); };
    window.addEventListener('pointerdown', liberar);
    window.addEventListener('keydown', liberar);
    return () => { window.removeEventListener('pointerdown', liberar); window.removeEventListener('keydown', liberar); };
  }, []);

  const tocar = useCallback((origens) => {
    const lista = ORDEM_SOM.filter((o) => origens.has(o));
    lista.forEach((o, i) => setTimeout(() => { if (!tocarSomPedido(o)) setSemSom(true); }, i * 1400));
    ultimoSom.current = Date.now();
  }, []);

  const buscar = useCallback(async () => {
    if (!ativo) return;
    let r;
    try { r = await api.get('/avisos/pedidos'); } catch { return; }
    const lista = r.pedidos || [];
    const ids = new Set(lista.map((p) => p.id));
    const primeiraVez = conhecidos.current === null;
    const novos = primeiraVez ? lista : lista.filter((p) => !conhecidos.current.has(p.id));
    conhecidos.current = ids;
    setPedidos(lista);
    setAgora(Date.now());
    // limpa da lista de dispensados o que ja saiu de "novo"
    const disp = dispensadosRef.current;
    if ([...disp].some((id) => !ids.has(id))) {
      const s = new Set([...disp].filter((id) => ids.has(id)));
      gravarDispensados(s);
      setDispensados(s);
    }
    const pendentes = lista.filter((p) => !disp.has(p.id));
    const chegaram = novos.filter((p) => !disp.has(p.id));
    if (chegaram.length) {
      tocar(new Set(chegaram.map((p) => p.origem)));
      if (!primeiraVez) {
        window.dispatchEvent(new CustomEvent('girostock:pedido-novo', { detail: chegaram }));
        // Aba minimizada ou em outra janela: aviso do sistema (se a pessoa permitiu)
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          for (const p of chegaram.slice(0, 3)) {
            try {
              const n = new Notification(`Novo pedido ${NOME[p.origem] || ''} #${p.codigo_externo || p.numero}`, {
                body: `${p.location_nome}${p.cliente_nome ? ` · ${p.cliente_nome}` : ''} · ${brl(p.total)}`, tag: `pedido-${p.id}`,
              });
              n.onclick = () => { window.focus(); n.close(); };
            } catch { /* sem notificacao */ }
          }
        }
      }
    } else if (pendentes.length && Date.now() - ultimoSom.current >= REPETIR_MS - 3000) { // folga: o relogio confere de 10 em 10 s
      tocar(new Set(pendentes.map((p) => p.origem)));
    }
  }, [ativo, tocar]);

  useEffect(() => {
    if (!ativo) { setPedidos([]); conhecidos.current = null; return undefined; }
    buscar();
    const parar = criarRelogio(buscar, INTERVALO_MS);
    const aoVoltar = () => { if (!document.hidden) buscar(); };
    const aoMudar = () => buscar();
    document.addEventListener('visibilitychange', aoVoltar);
    window.addEventListener('girostock:pedidos-mudaram', aoMudar);
    return () => { parar(); document.removeEventListener('visibilitychange', aoVoltar); window.removeEventListener('girostock:pedidos-mudaram', aoMudar); };
  }, [ativo, buscar]);

  function dispensar(id) {
    const s = new Set(dispensados);
    s.add(id);
    gravarDispensados(s);
    setDispensados(s);
  }
  function abrir(p) {
    dispensar(p.id);
    if (p.do_site) navigate('/loja-virtual/pedidos', { state: { abrir: p.id } });
    else navigate('/pedidos', { state: { abrir: p.id } });
  }
  function dispensarTodos() {
    const s = new Set([...dispensados, ...pedidos.map((p) => p.id)]);
    gravarDispensados(s);
    setDispensados(s);
  }

  const visiveis = pedidos.filter((p) => !dispensados.has(p.id)).reverse(); // mais novo em cima
  if (!ativo || visiveis.length === 0 || pathname === '/login') return null;
  const celular = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;
  const mostrar = visiveis.slice(0, celular ? 1 : 3); // no celular, so o mais novo (os outros no contador)
  const resto = visiveis.length - mostrar.length;
  return (
    <div className="aviso-pedidos" role="region" aria-label="Pedidos novos" aria-live="polite">
      {semSom && !somLiberado() && (
        <button type="button" className="aviso-pedidos-som" onClick={() => destravarSom().then(() => { setSemSom(false); tocar(new Set(visiveis.map((p) => p.origem))); })}>
          🔇 Clique aqui para ativar o som dos pedidos
        </button>
      )}
      {mostrar.map((p) => (
        <div key={p.id} className={`aviso-pedido origem-${p.origem}`}>
          <span className="aviso-pedido-icone" aria-hidden="true">{p.origem === 'ifood' ? 'iF' : p.origem === '99food' ? '99' : '🛍'}</span>
          <button type="button" className="aviso-pedido-corpo" onClick={() => abrir(p)}>
            <span className="aviso-pedido-topo">
              <b>Novo pedido · {NOME[p.origem]}{p.do_site ? ' (site)' : ''}</b>
              <small>{quandoChegou(p.criado_em, agora)}</small>
            </span>
            <span className="aviso-pedido-linha">#{p.codigo_externo || p.numero}{p.cliente_nome ? ` · ${p.cliente_nome}` : ''}</span>
            <span className="aviso-pedido-linha aviso-pedido-sub">
              {p.itens} {p.itens === 1 ? 'item' : 'itens'} · {brl(p.total)} · {p.tipo === 'entrega' ? 'Entrega' : p.tipo === 'retirada' ? 'Retirada' : p.tipo} · {p.location_nome}
            </span>
            <span className="aviso-pedido-abrir">Abrir pedido ›</span>
          </button>
          <button type="button" className="aviso-pedido-fechar" aria-label={`Fechar aviso do pedido ${p.codigo_externo || p.numero}`} onClick={() => dispensar(p.id)}>×</button>
        </div>
      ))}
      {(resto > 0 || visiveis.length > 1) && (
        <div className="aviso-pedidos-rodape">
          {resto > 0 && <span>+{resto} pedido(s) novo(s)</span>}
          <button type="button" className="btn-link" onClick={dispensarTodos}>Fechar todos</button>
        </div>
      )}
    </div>
  );
}

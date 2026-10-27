import { useEffect, useRef } from 'react';

const FOCAVEIS = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Folha inferior (bottom sheet) acessivel: dialogo modal, foco vai para dentro e volta ao botao de origem ao fechar,
// Esc fecha, Tab fica preso na folha e a pagina atras nao rola. A animacao some com prefers-reduced-motion (CSS).
export default function Folha({ titulo, aoFechar, children, rodape, larga }) {
  const ref = useRef(null);
  const fechar = useRef(aoFechar);
  fechar.current = aoFechar;
  useEffect(() => {
    const anterior = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const el = ref.current;
    const t = setTimeout(() => {
      if (!el) return;
      const alvo = el.querySelector('[data-foco]') || el.querySelector(FOCAVEIS);
      (alvo || el).focus({ preventScroll: true });
    }, 40);
    const tecla = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); fechar.current(); return; }
      if (e.key !== 'Tab' || !el) return;
      const lista = [...el.querySelectorAll(FOCAVEIS)].filter((x) => x.offsetParent !== null);
      if (lista.length === 0) { e.preventDefault(); return; }
      const primeiro = lista[0];
      const ultimo = lista[lista.length - 1];
      if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
    };
    document.addEventListener('keydown', tecla);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', tecla);
      document.body.style.overflow = overflow;
      if (anterior && anterior.focus) { try { anterior.focus({ preventScroll: true }); } catch { /* */ } }
    };
  }, []);
  return (
    <div className="cd-veu" onClick={aoFechar} role="presentation">
      <div ref={ref} className={`cd-folha ${larga ? 'larga' : ''}`} role="dialog" aria-modal="true" aria-label={titulo} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <header className="cd-folha-topo">
          <h2>{titulo}</h2>
          <button type="button" className="cd-fechar" onClick={aoFechar} aria-label="Fechar">×</button>
        </header>
        <div className="cd-folha-corpo">{children}</div>
        {rodape && <div className="cd-folha-rodape">{rodape}</div>}
      </div>
    </div>
  );
}

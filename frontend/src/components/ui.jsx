import { useEffect, useId, useRef } from 'react';

// Campo com rotulo fixo (o placeholder some ao digitar; o rotulo nao).
export function Field({ label, hint, children, className = '', style }) {
  const id = useId();
  return (
    <label className={`field ${className}`} htmlFor={id} style={style}>
      <span className="field-label">{label}</span>
      {typeof children === 'function' ? children(id) : children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

// Modal com fechamento por Esc e clique no fundo.
export function Modal({ titulo, subtitulo, onClose, largura = 'normal', children, acoes }) {
  const ref = useRef(null);
  useEffect(() => {
    // Com modais empilhados, o Esc fecha so o de cima.
    function onKey(e) {
      if (e.key !== 'Escape' || !onClose) return;
      const abertos = document.querySelectorAll('.modal');
      if (abertos[abertos.length - 1] === ref.current) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div ref={ref} className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div className={`modal-content ${largura === 'larga' ? 'wide' : ''} ${largura === 'extra' ? 'extra-wide' : ''}`}>
        <div className="modal-header">
          <div>
            <h3>{titulo}</h3>
            {subtitulo && <div className="modal-subtitle">{subtitulo}</div>}
          </div>
          {onClose && <button type="button" className="modal-close" aria-label="Fechar" onClick={onClose}>×</button>}
        </div>
        {children}
        {acoes && <div className="modal-actions">{acoes}</div>}
      </div>
    </div>
  );
}

export function Paginacao({ total, limit, offset, onChange }) {
  if (!total || total <= limit) return null;
  const pagina = Math.floor(offset / limit) + 1;
  const paginas = Math.ceil(total / limit);
  return (
    <div className="paginacao">
      <button type="button" className="btn-link" disabled={pagina <= 1} onClick={() => onChange(offset - limit)}>‹ Anterior</button>
      <span>Página {pagina} de {paginas} · {total} registros</span>
      <button type="button" className="btn-link" disabled={pagina >= paginas} onClick={() => onChange(offset + limit)}>Próxima ›</button>
    </div>
  );
}

export function Vazio({ children }) {
  return <div className="empty-state">{children}</div>;
}

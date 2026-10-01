import { useMemo, useRef, useState } from 'react';
import { brl } from '../utils/format';

function normalizar(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Campo de busca de produto (nome, codigo PRD ou EAN) sobre a lista ja carregada.
// Enter com um codigo de barras exato seleciona direto (funciona com leitor).
export default function ProdutoPicker({ produtos, valor, onSelecionar, placeholder = 'Buscar produto por nome, código ou EAN', autoFocus, limparAoSelecionar = false }) {
  const selecionado = produtos.find((p) => p.id === valor);
  const [texto, setTexto] = useState('');
  const [aberto, setAberto] = useState(false);
  const [indice, setIndice] = useState(0);
  const inputRef = useRef(null);

  const sugestoes = useMemo(() => {
    const t = normalizar(texto.trim());
    if (!t) return produtos.slice(0, 8);
    return produtos.filter((p) => normalizar(p.nome).includes(t) || p.barcode === texto.trim()
      || normalizar(p.codigo_interno).includes(t)).slice(0, 8);
  }, [texto, produtos]);

  function escolher(p) {
    onSelecionar(p);
    setTexto('');
    setAberto(false);
    if (limparAoSelecionar) setTimeout(() => inputRef.current?.focus(), 0);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAberto(true); setIndice((i) => Math.min(i + 1, sugestoes.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndice((i) => Math.max(i - 1, 0)); }
    if (e.key === 'Escape') setAberto(false);
    if (e.key === 'Enter') {
      e.preventDefault();
      const exato = produtos.find((p) => p.barcode === texto.trim());
      if (exato) escolher(exato);
      else if (aberto && sugestoes[indice]) escolher(sugestoes[indice]);
    }
  }

  return (
    <div className="produto-picker">
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        value={aberto || !selecionado || limparAoSelecionar ? texto : `${selecionado.nome} (${selecionado.codigo_interno})`}
        placeholder={placeholder}
        onFocus={() => { setAberto(true); setIndice(0); }}
        onBlur={() => setTimeout(() => setAberto(false), 150)}
        onChange={(e) => { setTexto(e.target.value); setAberto(true); setIndice(0); }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={aberto}
      />
      {aberto && sugestoes.length > 0 && (
        <ul className="picker-lista" role="listbox">
          {sugestoes.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === indice} className={i === indice ? 'ativo' : ''}
              onMouseDown={(e) => { e.preventDefault(); escolher(p); }} onMouseEnter={() => setIndice(i)}>
              <span>{p.nome}{!p.ativo ? ' (inativo)' : ''}</span>
              <span className="muted">{p.codigo_interno} · {p.barcode} · {brl(p.preco_venda)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../../api/client';

// Modulos (segmentos) que o Master libera por plano ou por empresa. Catalogo vem do backend (config/modulos.js).
let cacheCatalogo = null;
export function useCatalogoModulos() {
  const [catalogo, setCatalogo] = useState(cacheCatalogo);
  useEffect(() => {
    if (cacheCatalogo) return;
    api.get('/master/modulos').then((r) => { cacheCatalogo = r.modulos; setCatalogo(r.modulos); }).catch(() => setCatalogo([]));
  }, []);
  return catalogo;
}

let cachePlanos = null;
export function usePlanos(recarregar = 0) {
  const [planos, setPlanos] = useState(cachePlanos);
  useEffect(() => {
    api.get('/master/planos').then((r) => { cachePlanos = r.planos; setPlanos(r.planos); }).catch(() => setPlanos(cachePlanos || []));
  }, [recarregar]);
  return planos;
}

// Liga/desliga um modulo respeitando as dependencias: ligar leva junto o que ele precisa
// (Pedidos liga o PDV); desligar leva junto o que depende dele (sem PDV, sem Pedidos).
// Devolve { valores, junto: [nomes alterados alem do clicado] }.
export function alternarModulo(catalogo, valores, chave, ligar) {
  const novo = { ...valores, [chave]: ligar };
  const porChave = Object.fromEntries(catalogo.map((m) => [m.chave, m]));
  const junto = [];
  if (ligar) {
    const pilha = [...porChave[chave].requer];
    while (pilha.length) {
      const dep = pilha.pop();
      if (!novo[dep]) { novo[dep] = true; junto.push(porChave[dep].nome); pilha.push(...porChave[dep].requer); }
    }
  } else {
    let mudou = true;
    while (mudou) {
      mudou = false;
      for (const m of catalogo) {
        if (novo[m.chave] && m.requer.some((d) => !novo[d])) { novo[m.chave] = false; junto.push(m.nome); mudou = true; }
      }
    }
  }
  return { valores: novo, junto };
}

export function resumoModulos(catalogo, valores) {
  if (!catalogo || !valores) return '—';
  const lig = catalogo.filter((m) => valores[m.chave]).map((m) => m.nome);
  return lig.length ? lig.join(', ') : 'nenhum (só cadastros e estoque)';
}

// Lista de chaves liga/desliga. `detalhe(m)` devolve o texto pequeno sob o nome (origem, "volta ao plano" etc.).
export function ListaModulos({ catalogo, valores, onAlternar, detalhe, desabilitado }) {
  if (!catalogo) return <p className="muted">Carregando módulos…</p>;
  const nomes = Object.fromEntries(catalogo.map((m) => [m.chave, m.nome]));
  return (
    <div className="mod-lista">
      <p className="cl-sub" style={{ margin: '0 0 6px' }}>Sempre incluído: Início, Produtos &amp; Estoque, Fornecedores, Lojas &amp; PDVs, Usuários e Relatórios.</p>
      {catalogo.map((m) => (
        <div key={m.chave} className="cl-sw mod-item">
          <button type="button" role="switch" aria-checked={!!valores[m.chave]} aria-label={m.nome} className={valores[m.chave] ? 'on' : ''}
            disabled={desabilitado} onClick={() => onAlternar(m.chave, !valores[m.chave])} />
          <span>
            <b>{m.nome}</b>{!m.disponivel && <span className="ped-tag" style={{ marginLeft: 6 }}>em breve</span>}
            <div className="cl-sub">{m.descricao}{m.requer.length > 0 && <> · precisa de {m.requer.map((d) => nomes[d]).join(', ')}</>}</div>
            {detalhe && detalhe(m)}
          </span>
        </div>
      ))}
    </div>
  );
}

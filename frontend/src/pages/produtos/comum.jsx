// Pecas compartilhadas pelas abas de Produtos & Estoque.

export const UNIDADES_PRODUTO = ['UN', 'KG', 'L', 'CX'];
export const UNIDADES_INSUMO = ['G', 'KG', 'ML', 'L', 'UN', 'Fatia'];

export function stepDaUnidade(unidade) {
  return ['UN', 'CX'].includes(unidade) ? '1' : '0.001';
}

// Categorias em ordem de arvore: "Lanchonete", "— Lanches", ...
export function ordenarCategoriasHierarquia(categories) {
  const porPai = new Map();
  categories.forEach((c) => {
    const key = c.parent_id || null;
    if (!porPai.has(key)) porPai.set(key, []);
    porPai.get(key).push(c);
  });
  const resultado = [];
  function visitar(parentId, nivel) {
    const filhos = (porPai.get(parentId) || []).sort((a, b) => a.nome.localeCompare(b.nome));
    for (const c of filhos) {
      resultado.push({ ...c, nivel });
      visitar(c.id, nivel + 1);
    }
  }
  visitar(null, 0);
  return resultado;
}

// Fornecedor principal + fornecedores adicionais do produto.
export function SeletorFornecedores({ suppliers, principal, extras, onChange }) {
  const visiveis = suppliers.filter((s) => s.ativo || s.id === principal || extras.includes(s.id));
  const nome = (id) => (suppliers.find((s) => s.id === id) || { nome: id }).nome;
  const disponiveis = visiveis.filter((s) => s.id !== principal && !extras.includes(s.id) && s.ativo);
  return (
    <div className="form-stack" style={{ gap: '8px' }}>
      <select value={principal} onChange={(e) => onChange(e.target.value, extras.filter((x) => x !== e.target.value))}>
        <option value="">Sem fornecedor</option>
        {visiveis.map((s) => <option key={s.id} value={s.id}>{s.nome}{s.ativo ? '' : ' (inativo)'}</option>)}
      </select>
      {principal && (
        <>
          {extras.length > 0 && (
            <div className="chips">
              {extras.map((id) => (
                <span className="chip" key={id}>{nome(id)}
                  <button type="button" aria-label={`Remover ${nome(id)}`} onClick={() => onChange(principal, extras.filter((x) => x !== id))}>×</button>
                </span>
              ))}
            </div>
          )}
          {disponiveis.length > 0 && (
            <select value="" onChange={(e) => e.target.value && onChange(principal, [...extras, e.target.value])} aria-label="Adicionar outro fornecedor">
              <option value="">+ outro fornecedor deste produto</option>
              {disponiveis.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
            </select>
          )}
        </>
      )}
    </div>
  );
}

export function TIPO_MOV(tipo) {
  return { entrada: 'Entrada', saida: 'Saída', transferencia: 'Transferência' }[tipo] || tipo;
}

// Loja padrao dos formularios: a do usuario (se restrito), senao a ultima usada, senao a primeira ativa.
export function lojaPadrao(user, locaisAtivos) {
  if (user && user.locationId && locaisAtivos.some((l) => l.id === user.locationId)) return user.locationId;
  let ultima = null;
  try { ultima = localStorage.getItem('girostock_ultima_loja'); } catch { /* sem storage */ }
  if (ultima && locaisAtivos.some((l) => l.id === ultima)) return ultima;
  return (locaisAtivos[0] && locaisAtivos[0].id) || '';
}

export function lembrarLoja(id) {
  try { if (id) localStorage.setItem('girostock_ultima_loja', id); } catch { /* sem storage */ }
}

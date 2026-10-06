import { forwardRef, useState } from 'react';
import { Field } from '../../components/ui.jsx';
import { brl, brlFino, parseNumero, qtd } from '../../utils/format';

// Custo dos insumos da receita: soma de (qtd por unidade x custo unitario do insumo).
export function custoDaReceita(ficha, ingredients) {
  return ficha.reduce((soma, f) => {
    const ing = ingredients.find((i) => i.id === f.ingredient_id);
    return soma + (ing ? Number(ing.custo_unitario) * Number(f.quantidade_por_unidade) : 0);
  }, 0);
}

// Nomes dos insumos da receita que ainda estao sem custo (o custo da receita fica incompleto).
export function insumosSemCusto(ficha, ingredients) {
  return ficha.map((f) => ingredients.find((i) => i.id === f.ingredient_id)).filter((i) => i && !(Number(i.custo_unitario) > 0)).map((i) => i.nome);
}

// Quantas unidades do produto ainda dá para vender com os insumos disponiveis (todas as lojas).
export function podeVenderReceita(ficha, ingredients) {
  if (ficha.length === 0) return 0;
  return Math.min(...ficha.map((f) => {
    const ing = ingredients.find((i) => i.id === f.ingredient_id);
    const q = Number(f.quantidade_por_unidade);
    return ing && q > 0 ? Math.floor(Number(ing.saldo_total) / q) : 0;
  }));
}

const pillDa = (n) => (n === 0 ? 'err' : n <= 5 ? 'warn' : 'ok');

// Editor da receita (ficha tecnica) de um produto controlado por insumos.
// ficha = [{ ingredient_id, quantidade_por_unidade (numero) }]
const ReceitaEditor = forwardRef(function ReceitaEditor({ ficha, setFicha, ingredients, onErro }, ref) {
  const [novo, setNovo] = useState({ ingredient_id: '', quantidade: '' });
  const custo = custoDaReceita(ficha, ingredients);
  const max = podeVenderReceita(ficha, ingredients);
  const livres = ingredients.filter((i) => i.ativo && !ficha.some((f) => f.ingredient_id === i.id));
  const insumo = (id) => ingredients.find((i) => i.id === id);

  function mudarQtd(id, texto) {
    const n = parseNumero(texto);
    setFicha(ficha.map((f) => (f.ingredient_id === id ? { ...f, quantidade_por_unidade: Number.isFinite(n) && n > 0 ? n : 0.001 } : f)));
  }

  function adicionar() {
    const q = parseNumero(novo.quantidade);
    if (!novo.ingredient_id || !(q > 0)) { onErro('Escolha o insumo e informe a quantidade por unidade.'); return; }
    setFicha([...ficha, { ingredient_id: novo.ingredient_id, quantidade_por_unidade: q }]);
    setNovo({ ingredient_id: '', quantidade: '' });
  }

  return (
    <div ref={ref} className="form-stack">
      <div className="es-titulo" style={{ marginBottom: 0 }}>Controle por insumos (receita)</div>
      <div className="es-resumo">
        Este produto <b>não tem estoque próprio</b>: cada venda baixa os insumos abaixo e é bloqueada se algum faltar.{' '}
        {ficha.length > 0
          ? <>Hoje dá para vender <b>{max} unidade(s)</b>{max === 0 ? ' — falta insumo.' : '.'}</>
          : 'Adicione ao menos um insumo.'}
      </div>

      {ficha.length > 0 && (
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="tabela-wrap">
            <table className="compacta">
              <thead>
                <tr><th>Insumo</th><th className="num">Qtd por unidade</th><th className="num">Disponível</th><th className="num">Capac. prod</th><th className="num">Custo</th><th /></tr>
              </thead>
              <tbody>
                {ficha.map((f) => {
                  const ing = insumo(f.ingredient_id);
                  const q = Number(f.quantidade_por_unidade);
                  const dara = ing && q > 0 ? Math.floor(Number(ing.saldo_total) / q) : 0;
                  return (
                    <tr key={f.ingredient_id}>
                      <td><b>{ing ? ing.nome : '?'}</b>
                        {ing && <div className="celula-sub">{Number(ing.custo_unitario) > 0 ? `${brlFino(ing.custo_unitario)} / ${ing.unidade}` : <span style={{ color: 'var(--warn)' }}>sem custo: informe o custo total na entrada do insumo</span>}</div>}
                      </td>
                      <td className="num">
                        <input key={`${f.ingredient_id}-${q}`} className="es-min" inputMode="decimal" aria-label={`Quantidade de ${ing ? ing.nome : 'insumo'} por unidade`}
                          defaultValue={String(q).replace('.', ',')}
                          onBlur={(e) => mudarQtd(f.ingredient_id, e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} /> {ing ? ing.unidade : ''}
                      </td>
                      <td className="num">{qtd(ing ? ing.saldo_total : 0)} {ing ? ing.unidade : ''}</td>
                      <td className="num"><span className={`es-pill ${pillDa(dara)}`}>{dara} un.</span></td>
                      <td className="num">{brl(ing ? Number(ing.custo_unitario) * q : 0)}</td>
                      <td className="num"><button type="button" className="btn-link" aria-label={`Remover ${ing ? ing.nome : 'insumo'}`} onClick={() => setFicha(ficha.filter((x) => x.ingredient_id !== f.ingredient_id))}>×</button></td>
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={4} className="num"><b>Custo dos insumos (vira o custo do produto)</b></td>
                  <td className="num"><b style={{ color: 'var(--gold-light)' }}>{brl(custo)}</b></td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="es-linha-receita">
        <Field label="Adicionar insumo">
          <select value={novo.ingredient_id} onChange={(e) => setNovo({ ...novo, ingredient_id: e.target.value })}>
            <option value="">— selecione —</option>
            {livres.map((i) => <option key={i.id} value={i.id}>{i.nome} ({qtd(i.saldo_total)} {i.unidade})</option>)}
          </select>
        </Field>
        <Field label="Qtd por unidade">
          <input inputMode="decimal" placeholder="0" value={novo.quantidade} onChange={(e) => setNovo({ ...novo, quantidade: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); adicionar(); } }} />
        </Field>
        <button type="button" className="es-btn-ghost" onClick={adicionar}>+ Adicionar</button>
      </div>
      <div className="es-dica" style={{ marginTop: 0 }}>Para repor os insumos use a aba <b>Insumos</b> (entrada, saída, transferência e balanço por loja).</div>
    </div>
  );
});

export default ReceitaEditor;

import { Field } from '../../components/ui.jsx';
import { brlFino, parseNumero } from '../../utils/format';

// "Pode virar insumo na transferencia": o oleo de 1 L vendido inteiro na distribuidora vira 1.000 ML de insumo na lanchonete.
// estado: { ativa, ingredient_id ('' | id | '__novo'), nome_novo, unidade_nova, fator, modo: 'perguntar' | 'sempre', lojas: { [id]: true } }
// Compatibilidade de unidades igual a do servidor (services/conversao.js).
export const COMPATIVEIS = { L: ['ML', 'L'], KG: ['G', 'KG'], UN: ['UN', 'Fatia', 'G', 'ML'], CX: ['UN', 'Fatia', 'G', 'ML', 'KG', 'L'] };
const virg = (n) => String(n).replace('.', ',');
const num = (s) => { const n = parseNumero(s); return Number.isFinite(n) ? n : 0; };

export const estadoInicialConversao = () => ({ ativa: false, ingredient_id: '', nome_novo: '', unidade_nova: '', fator: '', modo: 'perguntar', lojas: {} });

export function conversaoDoServidor(c) {
  if (!c) return estadoInicialConversao();
  return {
    ativa: c.ativo !== false, ingredient_id: c.ingredient_id, nome_novo: '', unidade_nova: c.ingredient_unidade, fator: virg(c.fator),
    modo: c.modo, lojas: Object.fromEntries((c.lojas || []).map((id) => [id, true])),
  };
}

// corpo da API: objeto = grava; null = remove; undefined = nao mexe
export function payloadDeConversao(e, tinhaConversao, nomeProduto) {
  if (!e.ativa) return tinhaConversao ? null : undefined;
  const base = { fator: num(e.fator), modo: e.modo, lojas: Object.keys(e.lojas).filter((id) => e.lojas[id]), ativo: true };
  if (e.ingredient_id === '__novo') return { ...base, criar_insumo: { nome: (e.nome_novo || nomeProduto || '').trim(), unidade: e.unidade_nova } };
  return { ...base, ingredient_id: e.ingredient_id };
}

export function validarConversao(e, unidadeProduto) {
  if (!e.ativa) return '';
  if (!(num(e.fator) > 0)) return 'Conversão em insumo: informe quanto de insumo vale 1 unidade do produto.';
  if (!e.ingredient_id) return 'Conversão em insumo: escolha o insumo (ou crie um a partir do produto).';
  if (e.ingredient_id === '__novo' && !e.unidade_nova) return 'Conversão em insumo: escolha a unidade do insumo novo.';
  if (!Object.values(e.lojas).some(Boolean)) return 'Conversão em insumo: marque ao menos uma loja em que o produto vira insumo.';
  const un = e.ingredient_id === '__novo' ? e.unidade_nova : null;
  if (un && !(COMPATIVEIS[unidadeProduto] || []).includes(un)) return `Um produto em ${unidadeProduto} não vira insumo em ${un}.`;
  return '';
}

export default function ConversaoInsumo({ estado, setEstado, unidade, custo, locais, ingredients = [] }) {
  const ativos = locais.filter((l) => l.ativo);
  const compat = COMPATIVEIS[unidade] || [];
  const insumos = ingredients.filter((i) => i.ativo !== false && compat.includes(i.unidade));
  const set = (patch) => setEstado({ ...estado, ...patch });
  const novo = estado.ingredient_id === '__novo';
  const unInsumo = novo ? estado.unidade_nova : ((ingredients.find((i) => i.id === estado.ingredient_id) || {}).unidade || '');
  const fator = num(estado.fator);

  function ligar(v) {
    if (!v) return set({ ativa: false });
    // sugestao: litro vira ML e quilo vira G (fator 1.000)
    const sug = unidade === 'L' ? ['ML', '1000'] : unidade === 'KG' ? ['G', '1000'] : [compat[0] || '', ''];
    setEstado({ ...estado, ativa: true, unidade_nova: estado.unidade_nova || sug[0], fator: estado.fator || sug[1] });
  }

  return (
    <section className="pr-sec" id="secao-conversao">
      <h4>Pode virar insumo na transferência</h4>
      <p className="muted pr-sub">Para produtos vendidos inteiros numa loja e usados <b>por medida</b> em outra (ex.: 1 L de óleo vendido na distribuidora vira insumo em ML na lanchonete). A ficha técnica das receitas usa o <b>insumo</b>.</p>
      <label className="check">
        <input type="checkbox" checked={estado.ativa} onChange={(e) => ligar(e.target.checked)} /> Este produto pode virar insumo ao ser transferido
      </label>

      {estado.ativa && (
        <div className="pr-conv">
          <Field label="Vira qual insumo? *">
            <select value={estado.ingredient_id} onChange={(e) => set({ ingredient_id: e.target.value })}>
              <option value="">Escolha...</option>
              {insumos.map((i) => <option key={i.id} value={i.id}>{i.nome} ({i.unidade})</option>)}
              <option value="__novo">+ Criar insumo novo a partir deste produto</option>
            </select>
          </Field>
          {novo && (
            <>
              <Field label="Nome do insumo"><input value={estado.nome_novo} maxLength={120} placeholder="igual ao do produto" onChange={(e) => set({ nome_novo: e.target.value })} /></Field>
              <Field label="Unidade do insumo">
                <select value={estado.unidade_nova} onChange={(e) => set({ unidade_nova: e.target.value })}>
                  {compat.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </Field>
            </>
          )}
          <Field label={`1 ${unidade} do produto =`} hint={unInsumo ? `quantidade em ${unInsumo}` : 'escolha o insumo'}>
            <input inputMode="decimal" value={estado.fator} onChange={(e) => set({ fator: e.target.value })} />
          </Field>
          <div className="pr-conv-custo">
            <span className="field-label">Custo do insumo</span>
            <b>{fator > 0 && custo > 0 ? `${brlFino(custo / fator)} por ${unInsumo || 'unidade'}` : '—'}</b>
            <small className="muted">custo do produto ÷ fator, atualizado a cada transferência</small>
          </div>
          <div className="pr-conv-lojas">
            <span className="field-label">Em quais lojas vira insumo?</span>
            <div className="pr-conv-lista">
              {ativos.map((l) => (
                <label key={l.id} className="check">
                  <input type="checkbox" checked={!!estado.lojas[l.id]} onChange={(e) => set({ lojas: { ...estado.lojas, [l.id]: e.target.checked } })} /> {l.nome}
                  <em className="pr-tag">{estado.lojas[l.id] ? 'insumo' : 'continua produto'}</em>
                </label>
              ))}
            </div>
          </div>
          <Field label="Ao transferir para essas lojas">
            <select value={estado.modo} onChange={(e) => set({ modo: e.target.value })}>
              <option value="perguntar">Perguntar: converter ou manter como produto</option>
              <option value="sempre">Converter sempre (automático)</option>
            </select>
          </Field>
        </div>
      )}
    </section>
  );
}

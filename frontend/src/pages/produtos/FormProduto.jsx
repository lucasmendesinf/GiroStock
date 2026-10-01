import { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { brl, brlFino, parseNumero, pct } from '../../utils/format';
import { UNIDADES_PRODUTO, ordenarCategoriasHierarquia, SeletorFornecedores, stepDaUnidade, lojaPadrao, lembrarLoja } from './comum.jsx';
import Categorias from './Categorias.jsx';

// Cadastro de produto em modal. Produto "composto" (lanche/combo) usa ficha tecnica
// de insumos e nao tem estoque proprio.
export default function FormProduto({ categories, suppliers, locations, ingredients, reload, onClose, onSalvo }) {
  const toast = useToast();
  const { user } = useAuth();
  const locaisAtivos = locations.filter((l) => l.ativo);
  const localPadrao = lojaPadrao(user, locaisAtivos);
  const [form, setForm] = useState({
    nome: '', categoria_id: '', unidade: 'UN', barcode: '', preco_custo: '', preco_venda: '',
    supplier_id: '', supplier_ids: [], location_id: localPadrao, estoque_inicial: '0',
  });
  const [composto, setComposto] = useState(false);
  const [ficha, setFicha] = useState([]);
  const [novoItem, setNovoItem] = useState({ ingredient_id: '', quantidade_por_unidade: '' });
  const [categoriasAberto, setCategoriasAberto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const arvore = ordenarCategoriasHierarquia(categories);

  const custoInsumo = (id, q) => {
    const ing = ingredients.find((i) => i.id === id);
    return ing ? Number(ing.custo_unitario) * Number(q) : 0;
  };
  const custoFicha = ficha.reduce((s, f) => s + custoInsumo(f.ingredient_id, f.quantidade_por_unidade), 0);
  const custo = parseNumero(form.preco_custo);
  const venda = parseNumero(form.preco_venda);
  const margem = venda > 0 && custo >= 0 ? ((venda - custo) / venda) * 100 : null;

  function addInsumo() {
    const q = parseNumero(novoItem.quantidade_por_unidade);
    if (!novoItem.ingredient_id || !(q > 0)) { toast.erro('Escolha o insumo e a quantidade por unidade.'); return; }
    if (ficha.some((f) => f.ingredient_id === novoItem.ingredient_id)) { toast.erro('Este insumo já está na ficha.'); return; }
    const proxima = [...ficha, { ingredient_id: novoItem.ingredient_id, quantidade_por_unidade: q }];
    setFicha(proxima);
    const novoCusto = proxima.reduce((s, f) => s + custoInsumo(f.ingredient_id, f.quantidade_por_unidade), 0);
    setForm((f) => ({ ...f, preco_custo: novoCusto.toFixed(2).replace('.', ',') }));
    setNovoItem({ ingredient_id: '', quantidade_por_unidade: '' });
  }

  async function salvar(e) {
    e.preventDefault();
    if (composto && ficha.length === 0) { toast.erro('Adicione ao menos um insumo à ficha técnica.'); return; }
    setSalvando(true);
    try {
      const produto = await api.post('/products', {
        nome: form.nome,
        categoria_id: form.categoria_id,
        unidade: form.unidade,
        barcode: form.barcode.trim(),
        preco_custo: parseNumero(form.preco_custo),
        preco_venda: parseNumero(form.preco_venda),
        supplier_id: form.supplier_id || null,
        supplier_ids: form.supplier_ids,
        location_id: composto ? null : form.location_id,
        estoque_inicial: composto ? 0 : parseNumero(form.estoque_inicial || '0'),
        ficha_tecnica: composto ? ficha : [],
      });
      if (!composto) lembrarLoja(form.location_id);
      toast.sucesso(`Produto ${produto.codigo_interno} cadastrado.`);
      await reload();
      onSalvo(produto.id);
    } catch (err) {
      toast.erro(err);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Modal titulo="Novo produto" subtitulo="O código PRD é gerado ao salvar." onClose={onClose} largura="extra">
      <form onSubmit={salvar} className="form-stack">
        <div className="form-grid">
          <Field label="Nome do produto *" style={{ flexBasis: '100%' }}>
            <input autoFocus value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} minLength={3} required />
          </Field>
          <Field label="Categoria *">
            <select value={form.categoria_id} onChange={(e) => setForm({ ...form, categoria_id: e.target.value })} required>
              <option value="">Escolha...</option>
              {arvore.map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.nivel)}{c.nome}</option>)}
            </select>
          </Field>
          <button type="button" className="btn-link" onClick={() => setCategoriasAberto(true)}>+ Nova categoria</button>
          <Field label="Unidade" style={{ flex: '0 0 110px' }}>
            <select value={form.unidade} onChange={(e) => setForm({ ...form, unidade: e.target.value })}>
              {UNIDADES_PRODUTO.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
          <Field label="Código de barras (EAN) *" hint="8 a 14 dígitos. Pode usar o leitor.">
            <input inputMode="numeric" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} pattern="[0-9]{8,14}" required />
          </Field>
        </div>

        <div className="form-grid">
          <Field label="Preço de custo (R$) *" hint={composto ? 'Calculado pelos insumos (pode ajustar)' : undefined}>
            <input inputMode="decimal" value={form.preco_custo} onChange={(e) => setForm({ ...form, preco_custo: e.target.value })} placeholder="0,00" required />
          </Field>
          <Field label="Preço de venda (R$) *" hint={margem !== null && Number.isFinite(margem) ? `Margem: ${pct(margem.toFixed(1))}` : undefined}>
            <input inputMode="decimal" value={form.preco_venda} onChange={(e) => setForm({ ...form, preco_venda: e.target.value })} placeholder="0,00" required />
          </Field>
          <Field label="Fornecedor principal">
            <SeletorFornecedores suppliers={suppliers} principal={form.supplier_id} extras={form.supplier_ids}
              onChange={(principal, extras) => setForm({ ...form, supplier_id: principal, supplier_ids: principal ? extras : [] })} />
          </Field>
        </div>

        <div className="segmentado" role="radiogroup" aria-label="Tipo de produto">
          <button type="button" className={!composto ? 'ativo' : ''} onClick={() => setComposto(false)}>Produto com estoque próprio</button>
          <button type="button" className={composto ? 'ativo' : ''} onClick={() => setComposto(true)}>Produto composto (lanche, combo)</button>
        </div>

        {!composto && (
          <div className="form-grid">
            <Field label="Estoque inicial">
              <input type="number" min="0" step={stepDaUnidade(form.unidade)} value={form.estoque_inicial} onChange={(e) => setForm({ ...form, estoque_inicial: e.target.value })} />
            </Field>
            <Field label="Em qual loja *">
              <select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })} required>
                <option value="">Escolha...</option>
                {locaisAtivos.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
              </select>
            </Field>
          </div>
        )}

        {composto && (
          <div className="detail-section">
            <span className="detail-section-title">Ficha técnica (insumos por unidade vendida)</span>
            <span className="form-hint">Cada venda baixa esses insumos do estoque da loja do PDV. A venda é bloqueada se faltar algum.</span>
            {ficha.length > 0 && (
              <ul className="lista-simples">
                {ficha.map((f) => {
                  const ing = ingredients.find((i) => i.id === f.ingredient_id);
                  return (
                    <li key={f.ingredient_id}>
                      <span>{ing ? ing.nome : '?'} — {String(f.quantidade_por_unidade).replace('.', ',')} {ing ? ing.unidade : ''}</span>
                      <span>
                        <span className="muted">{brl(custoInsumo(f.ingredient_id, f.quantidade_por_unidade))}</span>{' '}
                        <button type="button" className="btn-link" onClick={() => setFicha(ficha.filter((x) => x.ingredient_id !== f.ingredient_id))}>Remover</button>
                      </span>
                    </li>
                  );
                })}
                <li><strong>Custo dos insumos</strong><strong>{brl(custoFicha)}</strong></li>
              </ul>
            )}
            <div className="form-grid">
              <Field label="Insumo">
                <select value={novoItem.ingredient_id} onChange={(e) => setNovoItem({ ...novoItem, ingredient_id: e.target.value })}>
                  <option value="">Escolha...</option>
                  {ingredients.filter((i) => i.ativo).map((i) => <option key={i.id} value={i.id}>{i.nome} ({brlFino(i.custo_unitario)}/{i.unidade})</option>)}
                </select>
              </Field>
              <Field label="Quantidade por unidade" style={{ flex: '0 0 170px' }}>
                <input inputMode="decimal" value={novoItem.quantidade_por_unidade} onChange={(e) => setNovoItem({ ...novoItem, quantidade_por_unidade: e.target.value })} placeholder="Ex: 150" />
              </Field>
              <button type="button" className="btn-link" onClick={addInsumo}>+ Adicionar insumo</button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" disabled={salvando}>{salvando ? 'Salvando...' : 'Salvar produto'}</button>
        </div>
      </form>
      {categoriasAberto && (
        <Categorias categories={categories} reload={reload} onClose={() => setCategoriasAberto(false)}
          onCriada={(c) => { setForm((f) => ({ ...f, categoria_id: c.id })); setCategoriasAberto(false); }} />
      )}
    </Modal>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useToast, useConfirm } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { brl, parseNumero, pct } from '../../utils/format';
import { UNIDADES_PRODUTO, ordenarCategoriasHierarquia, SeletorFornecedores } from './comum.jsx';
import ReceitaEditor, { custoDaReceita } from './ReceitaEditor.jsx';

const numeroParaCampo = (n) => String(n).replace('.', ',');

// Edicao do produto: so os dados cadastrais. Produto comum tem o botao "Tratar estoque →";
// produto controlado por insumos mostra a receita (e abre ja rolado ate ela).
export default function EditarProduto({ productId, categories, suppliers, ingredients, reload, onClose, onTratarEstoque }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [p, setP] = useState(null);
  const [form, setForm] = useState(null);
  const [ficha, setFicha] = useState([]);
  const [viraComposto, setViraComposto] = useState(false);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const receitaRef = useRef(null);

  const carregar = useCallback(async () => {
    try {
      const d = await api.get(`/products/${productId}`);
      setP(d);
      const principal = d.supplier_id || '';
      setForm({
        nome: d.nome, categoria_id: d.categoria_id || '', barcode: d.barcode, unidade: d.unidade,
        preco_custo: numeroParaCampo(d.preco_custo), preco_venda: numeroParaCampo(d.preco_venda),
        supplier_id: principal, supplier_ids: d.fornecedores.map((f) => f.id).filter((id) => id !== principal),
      });
      setFicha(d.ficha_tecnica.map((f) => ({ ingredient_id: f.ingredient_id, quantidade_por_unidade: Number(f.quantidade_por_unidade) })));
    } catch (err) { toast.erro(err); }
  }, [productId, toast]);

  useEffect(() => { carregar(); }, [carregar]);

  const compostoOriginal = !!p && p.ficha_tecnica.length > 0;
  // Produto composto aberto pelo lapis/caixa: rola ate a receita.
  useEffect(() => {
    if (compostoOriginal) setTimeout(() => receitaRef.current && receitaRef.current.scrollIntoView({ block: 'center' }), 60);
  }, [compostoOriginal]);

  if (!p || !form) return <Modal titulo="Carregando..." onClose={onClose} largura="extra"><p className="muted">Carregando produto...</p></Modal>;

  const semSaldo = p.saldos_por_local.every((s) => Number(s.saldo) === 0);
  const usaReceita = compostoOriginal || viraComposto;
  const custoFicha = custoDaReceita(ficha, ingredients);
  const custo = usaReceita ? custoFicha : parseNumero(form.preco_custo);
  const venda = parseNumero(form.preco_venda);
  const margem = venda > 0 && custo >= 0 ? ((venda - custo) / venda) * 100 : null;

  function validar() {
    const ean = form.barcode.replace(/\D/g, '');
    if (form.nome.trim().length < 3) return 'O nome precisa ter pelo menos 3 caracteres.';
    if (!form.categoria_id) return 'Escolha a categoria.';
    if (ean.length < 8 || ean.length > 14) return 'O código de barras deve ter de 8 a 14 dígitos.';
    if (usaReceita && ficha.length === 0) return 'Adicione ao menos um insumo à receita.';
    if (!(custo > 0)) return 'Informe o preço de custo (maior que zero).';
    if (!(venda > custo)) return usaReceita ? `O preço de venda precisa ser maior que o custo dos insumos (${brl(custo)}).` : 'O preço de venda precisa ser maior que o custo.';
    return '';
  }

  async function salvar(e) {
    e.preventDefault();
    const msg = validar();
    setErro(msg);
    if (msg) return;
    setSalvando(true);
    try {
      await api.put(`/products/${p.id}`, {
        nome: form.nome.trim(),
        categoria_id: form.categoria_id,
        barcode: form.barcode.replace(/\D/g, ''),
        unidade: form.unidade,
        preco_custo: custo,
        preco_venda: venda,
        supplier_id: form.supplier_id || null,
        supplier_ids: form.supplier_ids,
      });
      if (usaReceita) {
        const original = p.ficha_tecnica;
        const mudados = ficha.filter((f) => {
          const o = original.find((x) => x.ingredient_id === f.ingredient_id);
          return !o || Number(o.quantidade_por_unidade) !== Number(f.quantidade_por_unidade);
        });
        const removidos = original.filter((o) => !ficha.some((f) => f.ingredient_id === o.ingredient_id));
        for (const f of mudados) {
          await api.post(`/products/${p.id}/ingredients`, { ingredient_id: f.ingredient_id, quantidade_por_unidade: f.quantidade_por_unidade });
        }
        for (const o of removidos) await api.del(`/products/${p.id}/ingredients/${o.ingredient_id}`);
      }
      toast.sucesso('Produto atualizado.');
      await reload();
      onClose();
    } catch (err) {
      setErro(err.message);
      toast.erro(err);
    } finally {
      setSalvando(false);
    }
  }

  async function alternarStatus() {
    if (p.ativo && !(await confirmar({
      titulo: `Desativar "${p.nome}"?`,
      mensagem: 'O produto some do PDV e não recebe novas entradas. O histórico e o saldo continuam (ainda dá para transferir ou dar saída).',
      confirmar: 'Desativar', perigo: true,
    }))) return;
    try {
      await api.patch(`/products/${p.id}/status`, { ativo: !p.ativo });
      toast.sucesso(p.ativo ? 'Produto desativado.' : 'Produto reativado.');
      await reload();
      carregar();
    } catch (err) { toast.erro(err); }
  }

  return (
    <Modal titulo={<>{p.nome} {!p.ativo && <span className="badge-inativo">inativo</span>}</>}
      subtitulo={`Editar produto · ${p.codigo_interno}${compostoOriginal ? ' · controlado por insumos' : ''}`} onClose={onClose} largura="extra">
      <form onSubmit={salvar} className="form-stack" noValidate>
        <div className="es-resumo">
          {usaReceita
            ? <>Produto controlado por <b>insumos</b>: aqui você define a receita. O custo é calculado pelos insumos e não existe saldo para cadastrar.</>
            : <>Aqui ficam só os <b>dados do produto</b>. O saldo não é cadastrado aqui: use o botão <b>Tratar estoque</b> (ou o ícone de caixa da lista) para dar entrada, transferir ou ajustar estoque.</>}
        </div>

        <div className="form-grid">
          <Field label="Nome do produto *" style={{ flexBasis: '100%' }}>
            <input autoFocus value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
          </Field>
          <Field label="Categoria *">
            <select value={form.categoria_id} onChange={(e) => setForm({ ...form, categoria_id: e.target.value })}>
              {ordenarCategoriasHierarquia(categories).map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.nivel)}{c.nome}</option>)}
            </select>
          </Field>
          <Field label="Unidade" style={{ flex: '0 0 120px' }}>
            <select value={form.unidade} onChange={(e) => setForm({ ...form, unidade: e.target.value })}>
              {UNIDADES_PRODUTO.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
          <Field label="Código de barras / EAN *">
            <input inputMode="numeric" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} />
          </Field>
        </div>

        <div className="form-grid">
          <Field label="Preço de custo (R$) *" hint={usaReceita ? 'Calculado pelos insumos' : undefined}>
            <input inputMode="decimal" readOnly={usaReceita} value={usaReceita ? custoFicha.toFixed(2).replace('.', ',') : form.preco_custo}
              onChange={(e) => setForm({ ...form, preco_custo: e.target.value })} />
          </Field>
          <Field label="Preço de venda (R$) *" hint={margem !== null && Number.isFinite(margem) ? `Margem: ${pct(margem.toFixed(1))}` : undefined}>
            <input inputMode="decimal" value={form.preco_venda} onChange={(e) => setForm({ ...form, preco_venda: e.target.value })} />
          </Field>
          <Field label="Fornecedores">
            <SeletorFornecedores suppliers={suppliers} principal={form.supplier_id} extras={form.supplier_ids}
              onChange={(principal, extras) => setForm({ ...form, supplier_id: principal, supplier_ids: principal ? extras : [] })} />
          </Field>
        </div>

        {!compostoOriginal && semSaldo && (
          <label className="check">
            <input type="checkbox" checked={viraComposto} onChange={(e) => setViraComposto(e.target.checked)} /> Passar a controlar este produto por insumos (lanche / receita)
          </label>
        )}

        {usaReceita && <ReceitaEditor ref={receitaRef} ficha={ficha} setFicha={setFicha} ingredients={ingredients} onErro={setErro} />}

        {erro && <div className="es-erro">{erro}</div>}
        <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
          <button type="button" className={`btn-link ${p.ativo ? 'perigo' : ''}`} onClick={alternarStatus}>{p.ativo ? 'Desativar' : 'Reativar'}</button>
          {!compostoOriginal && !viraComposto && (
            <button type="button" className="es-btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => onTratarEstoque(p.id)}>Tratar estoque →</button>
          )}
          <button type="button" onClick={onClose} style={compostoOriginal || viraComposto ? { marginLeft: 'auto' } : undefined}>Cancelar</button>
          <button type="submit" disabled={salvando}>{salvando ? 'Salvando...' : 'Salvar alterações'}</button>
        </div>
      </form>
    </Modal>
  );
}

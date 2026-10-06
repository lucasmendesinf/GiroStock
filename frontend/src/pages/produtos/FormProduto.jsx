import { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { brl, parseNumero, pct } from '../../utils/format';
import { UNIDADES_PRODUTO, ordenarCategoriasHierarquia, SeletorFornecedores } from './comum.jsx';
import ReceitaEditor, { custoDaReceita, insumosSemCusto } from './ReceitaEditor.jsx';
import Categorias from './Categorias.jsx';

// Cadastro de produto: so os dados do produto. O saldo nao e cadastrado aqui (depois de salvar,
// o icone de caixa da lista trata o estoque). Produto controlado por insumos (lanche / receita)
// nao tem estoque proprio: o custo vem da soma dos insumos.
const textoCustoReceita = (ficha, ingredients) => {
  const sem = insumosSemCusto(ficha, ingredients);
  return sem.length ? `Soma dos insumos (atualiza ao mudar a receita). Sem custo: ${sem.join(', ')} — dê entrada informando o custo.` : 'Soma dos insumos (atualiza ao mudar a receita)';
};

export default function FormProduto({ categories, suppliers, ingredients, reload, onClose, onSalvo }) {
  const toast = useToast();
  const [form, setForm] = useState({
    nome: '', categoria_id: '', unidade: 'UN', barcode: '', preco_custo: '', preco_venda: '', supplier_id: '', supplier_ids: [],
  });
  const [composto, setComposto] = useState(false);
  const [ficha, setFicha] = useState([]);
  const [erro, setErro] = useState('');
  const [categoriasAberto, setCategoriasAberto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const arvore = ordenarCategoriasHierarquia(categories);

  const custoFicha = custoDaReceita(ficha, ingredients);
  const custo = composto ? custoFicha : parseNumero(form.preco_custo);
  const venda = parseNumero(form.preco_venda);
  const margem = venda > 0 && custo >= 0 ? ((venda - custo) / venda) * 100 : null;

  function validar() {
    const ean = form.barcode.replace(/\D/g, '');
    if (form.nome.trim().length < 3) return 'O nome precisa ter pelo menos 3 caracteres.';
    if (!form.categoria_id) return 'Escolha a categoria.';
    if (ean.length < 8 || ean.length > 14) return 'O código de barras deve ter de 8 a 14 dígitos.';
    if (composto && ficha.length === 0) return 'Adicione ao menos um insumo à receita.';
    if (!(custo > 0)) return 'Informe o preço de custo (maior que zero).';
    if (!(venda > custo)) return composto ? `O preço de venda precisa ser maior que o custo dos insumos (${brl(custo)}).` : 'O preço de venda precisa ser maior que o custo.';
    return '';
  }

  async function salvar(e) {
    e.preventDefault();
    const msg = validar();
    setErro(msg);
    if (msg) return;
    setSalvando(true);
    try {
      const produto = await api.post('/products', {
        nome: form.nome.trim(),
        categoria_id: form.categoria_id,
        unidade: form.unidade,
        barcode: form.barcode.replace(/\D/g, ''),
        preco_custo: custo,
        preco_venda: venda,
        supplier_id: form.supplier_id || null,
        supplier_ids: form.supplier_ids,
        ficha_tecnica: composto ? ficha.map((f) => ({ ingredient_id: f.ingredient_id, quantidade_por_unidade: f.quantidade_por_unidade })) : [],
      });
      toast.sucesso(composto
        ? `Produto ${produto.codigo_interno} cadastrado — receita salva.`
        : `Produto ${produto.codigo_interno} cadastrado — agora use o ícone de caixa para lançar o estoque.`);
      await reload();
      onSalvo(produto.id);
    } catch (err) {
      setErro(err.message);
      toast.erro(err);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Modal titulo="Cadastrar produto" subtitulo="Novo produto · o código PRD é gerado ao salvar." onClose={onClose} largura="extra">
      <form onSubmit={salvar} className="form-stack" noValidate>
        <div className="es-resumo">
          {composto
            ? <>Produto controlado por <b>insumos</b>: aqui você define a receita. O custo é calculado pelos insumos e não existe saldo para cadastrar.</>
            : <>Aqui ficam só os <b>dados do produto</b>. O saldo não é cadastrado aqui: depois de salvar, use o <b>ícone de caixa</b> da lista para dar a primeira entrada, transferir ou ajustar estoque.</>}
        </div>

        <div className="form-grid">
          <Field label="Nome do produto *" style={{ flexBasis: '100%' }}>
            <input autoFocus value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex.: Cerveja Heineken Long Neck 330ml" />
          </Field>
          <Field label="Categoria *">
            <select value={form.categoria_id} onChange={(e) => setForm({ ...form, categoria_id: e.target.value })}>
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
          <Field label="Código de barras / EAN *" hint="8 a 14 dígitos. Pode usar o leitor.">
            <input inputMode="numeric" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} placeholder="8 a 14 dígitos" />
          </Field>
        </div>

        <div className="es-form" style={{ alignItems: 'start' }}>
          <Field label="Preço de custo (R$) *" hint={composto ? textoCustoReceita(ficha, ingredients) : undefined}>
            <input inputMode="decimal" readOnly={composto} placeholder="0,00"
              value={composto ? custoFicha.toFixed(2).replace('.', ',') : form.preco_custo}
              onChange={(e) => setForm({ ...form, preco_custo: e.target.value })} />
          </Field>
          <Field label="Preço de venda (R$) *" hint={margem !== null && Number.isFinite(margem) ? `Margem: ${pct(margem.toFixed(1))}` : undefined}>
            <input inputMode="decimal" value={form.preco_venda} onChange={(e) => setForm({ ...form, preco_venda: e.target.value })} placeholder="0,00" />
          </Field>
          <Field label="Fornecedor principal" className="full">
            <SeletorFornecedores suppliers={suppliers} principal={form.supplier_id} extras={form.supplier_ids}
              onChange={(principal, extras) => setForm({ ...form, supplier_id: principal, supplier_ids: principal ? extras : [] })} />
          </Field>
        </div>

        <label className="check">
          <input type="checkbox" checked={composto} onChange={(e) => setComposto(e.target.checked)} /> Produto controlado por insumos (lanche / receita)
        </label>

        {composto && <ReceitaEditor ficha={ficha} setFicha={setFicha} ingredients={ingredients} onErro={setErro} />}

        {erro && <div className="es-erro">{erro}</div>}
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

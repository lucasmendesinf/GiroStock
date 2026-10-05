import { useState } from 'react';
import { api } from '../../api/client';
import { useToast, useConfirm } from '../../context/UiContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { Field, Vazio } from '../../components/ui.jsx';
import ProdutoPicker from '../../components/ProdutoPicker.jsx';
import { brl, parseNumero } from '../../utils/format';
import { stepDaUnidade, lojaPadrao, lembrarLoja } from './comum.jsx';

// Entrada de varios produtos de uma mesma nota de compra, gravada de uma vez (tudo ou nada).
export default function EntradaNota({ products, locations, suppliers, reload }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const { user } = useAuth();
  const locaisAtivos = locations.filter((l) => l.ativo);
  const localPadrao = lojaPadrao(user, locaisAtivos);
  const [cab, setCab] = useState({ location_id: localPadrao, supplier_id: '', documento_fiscal: '' });
  const [itens, setItens] = useState([]);
  const [salvando, setSalvando] = useState(false);
  const elegiveis = products.filter((p) => p.ativo && !p.tem_ficha_tecnica);

  function adicionar(p) {
    if (itens.some((i) => i.product_id === p.id)) {
      toast.erro(`"${p.nome}" já está na nota. Ajuste a quantidade na linha dele.`);
      return;
    }
    setItens([...itens, { product_id: p.id, nome: p.nome, unidade: p.unidade, codigo: p.codigo_interno, quantidade: '', custo_unitario: String(p.preco_custo).replace('.', ',') }]);
    setTimeout(() => document.getElementById(`qtd-${p.id}`)?.focus(), 0);
  }

  function atualizar(id, campo, valor) {
    setItens(itens.map((i) => (i.product_id === id ? { ...i, [campo]: valor } : i)));
  }

  const totalNota = itens.reduce((s, i) => {
    const q = parseNumero(i.quantidade);
    const c = parseNumero(i.custo_unitario);
    return s + (q > 0 && c > 0 ? q * c : 0);
  }, 0);

  async function limpar() {
    if (itens.length && !(await confirmar({ titulo: 'Descartar os itens desta nota?', confirmar: 'Descartar', perigo: true }))) return;
    setItens([]);
  }

  async function gravar(e) {
    e.preventDefault();
    if (itens.length === 0) { toast.erro('Adicione ao menos um produto.'); return; }
    setSalvando(true);
    try {
      const r = await api.post('/stock-entries', {
        location_id: cab.location_id,
        supplier_id: cab.supplier_id || null,
        documento_fiscal: cab.documento_fiscal,
        itens: itens.map((i) => ({
          product_id: i.product_id,
          quantidade: parseNumero(i.quantidade),
          custo_unitario: i.custo_unitario === '' ? null : parseNumero(i.custo_unitario),
        })),
      });
      lembrarLoja(cab.location_id);
      toast.sucesso(`Nota lançada: ${r.itens} produto(s), ${brl(r.valor_total)}.`);
      setItens([]);
      setCab({ ...cab, documento_fiscal: '' });
      reload();
    } catch (err) {
      toast.erro(err);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <form onSubmit={gravar}>
      <div className="card">
        <h3>Dados da nota</h3>
        <div className="form-grid" style={{ marginTop: '12px' }}>
          <Field label="Loja que recebe *">
            <select value={cab.location_id} onChange={(e) => setCab({ ...cab, location_id: e.target.value })} required>
              <option value="">Escolha...</option>
              {locaisAtivos.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
            </select>
          </Field>
          <Field label="Fornecedor">
            <select value={cab.supplier_id} onChange={(e) => setCab({ ...cab, supplier_id: e.target.value })}>
              <option value="">—</option>
              {suppliers.filter((s) => s.ativo).map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
            </select>
          </Field>
          <Field label="Número da nota fiscal"><input value={cab.documento_fiscal} onChange={(e) => setCab({ ...cab, documento_fiscal: e.target.value })} placeholder="Ex: 12345" /></Field>
        </div>
      </div>

      <div className="card">
        <h3>Itens</h3>
        <div style={{ margin: '12px 0' }}>
          <ProdutoPicker produtos={elegiveis} onSelecionar={adicionar} limparAoSelecionar placeholder="Bipe o código de barras ou digite o nome para adicionar" />
        </div>
        {itens.length === 0 ? <Vazio>Nenhum item. Use o campo acima (aceita leitor de código de barras).</Vazio> : (
          <div className="tabela-wrap">
            <table>
              <thead><tr><th>Produto</th><th>Qtd</th><th>Custo un. (R$)</th><th className="num col-opcional">Subtotal</th><th /></tr></thead>
              <tbody>
                {itens.map((i) => {
                  const q = parseNumero(i.quantidade);
                  const c = parseNumero(i.custo_unitario);
                  return (
                    <tr key={i.product_id}>
                      <td>{i.nome}<div className="celula-sub">{i.codigo} · {i.unidade}</div></td>
                      <td><input id={`qtd-${i.product_id}`} className="input-curto" type="number" min="0" step={stepDaUnidade(i.unidade)} value={i.quantidade} onChange={(e) => atualizar(i.product_id, 'quantidade', e.target.value)} required /></td>
                      <td><input className="input-curto" inputMode="decimal" value={i.custo_unitario} onChange={(e) => atualizar(i.product_id, 'custo_unitario', e.target.value)} /></td>
                      <td className="num col-opcional">{q > 0 && c > 0 ? brl(q * c) : '—'}</td>
                      <td><button type="button" className="btn-link" onClick={() => setItens(itens.filter((x) => x.product_id !== i.product_id))}>Remover</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="nota-rodape">
          <span>{itens.length} produto(s) · Total da nota: <strong>{brl(totalNota)}</strong></span>
          <div className="row-actions">
            {itens.length > 0 && <button type="button" className="btn-link" onClick={limpar}>Descartar</button>}
            <button type="submit" className="btn-primario" disabled={salvando || itens.length === 0}>{salvando ? 'Lançando...' : 'Lançar nota no estoque'}</button>
          </div>
        </div>
        <p className="form-hint">O custo vem preenchido com o custo atual; altere para o valor da nota. O custo de cada produto é recalculado pela média ponderada.</p>
      </div>
    </form>
  );
}

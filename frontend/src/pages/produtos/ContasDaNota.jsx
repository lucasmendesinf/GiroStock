import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { brl, parseNumero } from '../../utils/format';

const maisDias = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const hoje = () => { const d = new Date(); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };

// Depois de importar a NF-e no estoque: lancar as contas a pagar da nota (as duplicatas do XML; sem duplicata,
// uma parcela com o total da nota). Categoria "Compra de mercadorias" (fora do resultado: o custo entra pelo CMV).
export default function ContasDaNota({ nota, onClose }) {
  const toast = useToast();
  const [opcoes, setOpcoes] = useState(null);
  const [categoria, setCategoria] = useState('');
  const [parcelas, setParcelas] = useState(() => {
    const base = nota.duplicatas && nota.duplicatas.length > 0
      ? nota.duplicatas
      : [{ numero: '', vencimento: maisDias(nota.emissao || hoje(), 30), valor: nota.totalNota || nota.valorEstoque || 0 }];
    return base.map((d) => ({ numero: d.numero, vencimento: d.vencimento, valorTxt: String(Number(d.valor).toFixed(2)).replace('.', ',') }));
  });
  const [salvando, setSalvando] = useState(false);
  useEffect(() => {
    api.get('/financeiro/opcoes').then((o) => {
      setOpcoes(o);
      const c = o.categorias.find((x) => x.tipo === 'despesa' && /mercadoria/i.test(x.nome));
      if (c) setCategoria(c.id);
    }).catch(() => setOpcoes({ categorias: [] }));
  }, []);
  const total = parcelas.reduce((s, p) => s + (parseNumero(p.valorTxt) || 0), 0);
  const mudar = (i, k, v) => setParcelas(parcelas.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const validas = parcelas.length > 0 && parcelas.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.vencimento) && parseNumero(p.valorTxt) > 0);

  async function lancar() {
    setSalvando(true);
    try {
      const r = await api.post('/financeiro/titulos', {
        tipo: 'pagar', origem: 'nota', descricao: `NF-e ${nota.numero || ''} - ${nota.emitente || 'fornecedor'}`.trim(),
        supplier_id: nota.supplierId, documento: nota.numero || null, categoria_id: categoria || null, competencia: nota.emissao || null,
        parcelas_informadas: parcelas.map((p) => ({ numero: p.numero || null, vencimento: p.vencimento, valor: p.valorTxt })),
      });
      toast.sucesso(`${r.length} conta(s) a pagar lançada(s) no Financeiro · ${brl(total)}`);
      onClose();
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }

  return (
    <Modal titulo="Lançar as contas a pagar desta nota?" subtitulo={`NF-e ${nota.numero || '—'} · ${nota.emitente || ''}${nota.totalNota ? ` · total da nota ${brl(nota.totalNota)}` : ''}`} onClose={onClose} largura="larga">
      <div className="form-stack">
        <p className="form-hint" style={{ margin: 0 }}>
          {nota.duplicatas && nota.duplicatas.length > 0 ? `A nota traz ${nota.duplicatas.length} duplicata(s) (boletos). Confira os vencimentos e valores.` : 'A nota não traz duplicatas: uma parcela com o total da nota, vencendo em 30 dias. Ajuste se precisar.'}
        </p>
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Parcela</th><th>Vencimento</th><th className="num">Valor (R$)</th><th /></tr></thead>
            <tbody>
              {parcelas.map((p, i) => (
                <tr key={i}>
                  <td>{p.numero || `${i + 1}/${parcelas.length}`}</td>
                  <td><input type="date" aria-label={`Vencimento da parcela ${i + 1}`} value={p.vencimento} onChange={(e) => mudar(i, 'vencimento', e.target.value)} /></td>
                  <td className="num"><input className="es-min" inputMode="decimal" aria-label={`Valor da parcela ${i + 1}`} value={p.valorTxt} onChange={(e) => mudar(i, 'valorTxt', e.target.value)} /></td>
                  <td className="num">{parcelas.length > 1 && <button type="button" className="btn-link perigo" onClick={() => setParcelas(parcelas.filter((_, j) => j !== i))}>Remover</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ped-linha"><span>Total</span><b>{brl(total)}</b></div>
        {opcoes && (
          <Field label="Categoria">
            <select value={categoria} onChange={(e) => setCategoria(e.target.value)}>
              <option value="">Sem categoria</option>
              {opcoes.categorias.filter((c) => c.tipo === 'despesa').map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          </Field>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Agora não</button>
          <button type="button" className="btn-primario" disabled={!validas || salvando} onClick={lancar}>{salvando ? 'Lançando…' : `Lançar ${parcelas.length} conta(s) a pagar`}</button>
        </div>
      </div>
    </Modal>
  );
}

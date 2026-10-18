import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { brl } from '../../utils/format';
import { diaBR, hojeISO } from './util.jsx';

const TIPOS_CONTA = { banco: 'Banco', caixa: 'Caixa / cofre', carteira: 'Carteira digital' };

// Contas (onde o dinheiro esta), formas de recebimento das vendas (prazo, taxa, conta) e categorias.
export default function Cadastros({ onMudou }) {
  const [versaoContas, setVersaoContas] = useState(0); // conta nova/alterada: a lista das formas recarrega
  return (
    <div className="form-stack">
      <Contas onMudou={() => { setVersaoContas((v) => v + 1); onMudou(); }} />
      <Formas onMudou={onMudou} versaoContas={versaoContas} />
      <Categorias onMudou={onMudou} />
    </div>
  );
}

function Contas({ onMudou }) {
  const toast = useToast();
  const [lista, setLista] = useState(null);
  const [editando, setEditando] = useState(null); // {} = nova
  const carregar = useCallback(() => api.get('/financeiro/contas').then(setLista).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  return (
    <div className="card">
      <div className="ped-head" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Contas</h3>
        <button type="button" className="btn-primario" onClick={() => setEditando({})}>+ Nova conta</button>
      </div>
      <p className="form-hint" style={{ marginTop: 0 }}>Onde o dinheiro fica: conta no banco, cofre da loja, carteira digital. Informe o saldo de um dia; dali em diante o sistema soma as vendas e as contas pagas/recebidas.</p>
      {lista && lista.length > 0 && (
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Conta</th><th>Tipo</th><th className="num">Saldo inicial</th><th className="num">Saldo hoje</th><th /></tr></thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.id} style={{ opacity: c.ativo ? 1 : 0.55 }}>
                  <td><b>{c.nome}</b>{!c.ativo && <span className="badge-inativo"> inativa</span>}</td>
                  <td>{TIPOS_CONTA[c.tipo]}</td>
                  <td className="num">{brl(c.saldo_inicial)}<div className="celula-sub">em {diaBR(c.saldo_inicial_em)}</div></td>
                  <td className="num"><b style={{ color: c.saldo < 0 ? 'var(--err)' : undefined }}>{brl(c.saldo)}</b></td>
                  <td className="num"><button type="button" className="btn-link" onClick={() => setEditando(c)}>Editar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editando && <ContaModal conta={editando} onClose={() => setEditando(null)} onSalvo={async () => { setEditando(null); await carregar(); onMudou(); }} />}
    </div>
  );
}

function ContaModal({ conta, onClose, onSalvo }) {
  const toast = useToast();
  const nova = !conta.id;
  const [f, setF] = useState({ nome: conta.nome || '', tipo: conta.tipo || 'banco', saldo_inicial: conta.saldo_inicial !== undefined ? String(conta.saldo_inicial).replace('.', ',') : '0', saldo_inicial_em: conta.saldo_inicial_em || hojeISO(), ativo: conta.ativo !== false });
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function salvar(e) {
    e.preventDefault();
    try {
      if (nova) await api.post('/financeiro/contas', f); else await api.patch(`/financeiro/contas/${conta.id}`, f);
      toast.sucesso(nova ? 'Conta criada' : 'Conta atualizada');
      await onSalvo();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo={nova ? 'Nova conta' : `Editar ${conta.nome}`} onClose={onClose}>
      <form className="form-stack" onSubmit={salvar}>
        <Field label="Nome *"><input autoFocus value={f.nome} onChange={mudar('nome')} placeholder="Ex.: Banco do Brasil, Cofre da loja" maxLength={80} /></Field>
        <Field label="Tipo"><select value={f.tipo} onChange={mudar('tipo')}>{Object.entries(TIPOS_CONTA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <div className="form-grid">
          <Field label="Saldo (R$)"><input inputMode="decimal" value={f.saldo_inicial} onChange={mudar('saldo_inicial')} /></Field>
          <Field label="Saldo do dia"><input type="date" value={f.saldo_inicial_em} onChange={mudar('saldo_inicial_em')} /></Field>
        </div>
        {!nova && <label className="check"><input type="checkbox" checked={f.ativo} onChange={mudar('ativo')} /> Conta ativa</label>}
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button type="submit" className="btn-primario" disabled={f.nome.trim().length < 2}>Salvar</button></div>
      </form>
    </Modal>
  );
}

function Formas({ onMudou, versaoContas }) {
  const toast = useToast();
  const [formas, setFormas] = useState(null);
  const [contas, setContas] = useState([]);
  const [editadas, setEditadas] = useState({});
  useEffect(() => { api.get('/financeiro/formas').then(setFormas).catch((err) => toast.erro(err)); }, [toast]);
  useEffect(() => { api.get('/financeiro/contas').then((l) => setContas(l.filter((c) => c.ativo))).catch(() => {}); }, [versaoContas]);
  if (!formas) return null;
  const valor = (f, k) => (editadas[f.forma] && editadas[f.forma][k] !== undefined ? editadas[f.forma][k] : f[k]);
  const mudar = (f, k, v) => setEditadas({ ...editadas, [f.forma]: { ...(editadas[f.forma] || {}), [k]: v } });
  async function salvar(f) {
    try {
      const r = await api.put(`/financeiro/formas/${f.forma}`, { prazo_dias: Number(valor(f, 'prazo_dias')), taxa_pct: String(valor(f, 'taxa_pct')), conta_id: valor(f, 'conta_id') || null });
      setFormas(formas.map((x) => (x.forma === f.forma ? r : x)));
      const { [f.forma]: _, ...resto } = editadas; // eslint-disable-line no-unused-vars
      setEditadas(resto);
      toast.sucesso(`${f.nome}: salvo`);
      onMudou();
    } catch (err) { toast.erro(err); }
  }
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Formas de pagamento das vendas</h3>
      <p className="form-hint" style={{ marginTop: 0 }}>Quando o dinheiro de cada venda cai e quanto a operadora/app desconta. Ex.: crédito em 30 dias com 3,49%. Usado no fluxo de caixa, nas vendas a receber e no resultado.</p>
      <div className="tabela-wrap">
        <table className="tabela-cartoes fin-formas">
          <thead><tr><th>Forma</th><th>Cai em (dias)</th><th>Taxa (%)</th><th>Cai na conta</th><th /></tr></thead>
          <tbody>
            {formas.map((f) => (
              <tr key={f.forma}>
                <td><b>{f.nome}</b></td>
                <td><input className="es-min" inputMode="numeric" aria-label={`Prazo de ${f.nome}`} value={valor(f, 'prazo_dias')} onChange={(e) => mudar(f, 'prazo_dias', e.target.value)} /></td>
                <td><input className="es-min" inputMode="decimal" aria-label={`Taxa de ${f.nome}`} value={String(valor(f, 'taxa_pct')).replace('.', ',')} onChange={(e) => mudar(f, 'taxa_pct', e.target.value.replace(',', '.'))} /></td>
                <td><select aria-label={`Conta de ${f.nome}`} value={valor(f, 'conta_id') || ''} onChange={(e) => mudar(f, 'conta_id', e.target.value)}><option value="">—</option>{contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></td>
                <td className="num">{editadas[f.forma] ? <button type="button" className="btn-primario" onClick={() => salvar(f)}>Salvar</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Categorias({ onMudou }) {
  const toast = useToast();
  const [lista, setLista] = useState(null);
  const [nova, setNova] = useState({ tipo: 'despesa', nome: '' });
  const carregar = useCallback(() => api.get('/financeiro/categorias').then(setLista).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  async function criar(e) {
    e.preventDefault();
    try { await api.post('/financeiro/categorias', nova); setNova({ ...nova, nome: '' }); await carregar(); onMudou(); } catch (err) { toast.erro(err); }
  }
  async function alterar(c, mud) {
    try { await api.patch(`/financeiro/categorias/${c.id}`, mud); await carregar(); onMudou(); } catch (err) { toast.erro(err); }
  }
  if (!lista) return null;
  const grupo = (tipo, titulo) => (
    <div style={{ flex: '1 1 280px' }}>
      <div className="es-titulo">{titulo}</div>
      <ul className="lista-simples">
        {lista.filter((c) => c.tipo === tipo).map((c) => (
          <li key={c.id} style={{ opacity: c.ativo ? 1 : 0.55 }}>
            <span>{c.nome}{!c.entra_no_resultado && <span className="celula-sub"> · fora do resultado</span>}{c.lancamentos > 0 && <span className="celula-sub"> · {c.lancamentos} lanç.</span>}</span>
            <button type="button" className={`btn-link ${c.ativo ? 'perigo' : ''}`} onClick={() => alterar(c, { ativo: !c.ativo })}>{c.ativo ? 'Desativar' : 'Reativar'}</button>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Categorias</h3>
      <form className="ped-bar" onSubmit={criar}>
        <select value={nova.tipo} onChange={(e) => setNova({ ...nova, tipo: e.target.value })} aria-label="Tipo"><option value="despesa">Despesa</option><option value="receita">Receita</option></select>
        <input className="ped-busca" value={nova.nome} onChange={(e) => setNova({ ...nova, nome: e.target.value })} placeholder="Nova categoria" aria-label="Nome da categoria" maxLength={80} />
        <button type="submit" className="btn-primario" disabled={nova.nome.trim().length < 2}>Adicionar</button>
      </form>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {grupo('despesa', 'Despesas')}
        {grupo('receita', 'Receitas')}
      </div>
      <p className="form-hint">"Fora do resultado": compra de mercadoria para revenda. O custo dela já entra no resultado pelo custo das mercadorias vendidas; contar de novo seria em dobro.</p>
    </div>
  );
}

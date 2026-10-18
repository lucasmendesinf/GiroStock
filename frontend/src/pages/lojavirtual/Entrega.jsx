import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';
import { Field, Modal, Vazio } from '../../components/ui.jsx';
import { brl, parseNumero } from '../../utils/format';

const valor = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

// Bairros atendidos com a taxa de cada um (e, se quiser, uma taxa para qualquer outro bairro).
export default function Entrega({ config, onMudou }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [lista, setLista] = useState(null);
  const [editando, setEditando] = useState(null); // {} = novos bairros
  const [outros, setOutros] = useState({ ligado: config.taxa_outros_bairros !== null, taxa: valor(config.taxa_outros_bairros) });
  const carregar = useCallback(() => api.get('/loja-virtual/regioes').then(setLista).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);

  async function salvarOutros(e) {
    e.preventDefault();
    try {
      await api.put('/loja-virtual', { taxa_outros_bairros: outros.ligado ? parseNumero(outros.taxa) || 0 : null });
      toast.sucesso(outros.ligado ? 'Taxa para outros bairros salva' : 'Entrega só nos bairros da lista');
      await onMudou();
    } catch (err) { toast.erro(err); }
  }
  async function remover(r) {
    if (!(await confirmar({ titulo: `Remover o bairro ${r.nome}?`, mensagem: 'O site deixa de entregar neste bairro (a não ser que haja taxa para outros bairros).', confirmar: 'Remover', perigo: true }))) return;
    try { await api.del(`/loja-virtual/regioes/${r.id}`); toast.sucesso('Bairro removido'); await carregar(); await onMudou(); } catch (err) { toast.erro(err); }
  }

  return (
    <div className="form-stack">
      {!config.aceita_entrega && <div className="ped-nota">A entrega está desligada em <b>Visão geral → Funcionamento</b>: o site só oferece retirada.</div>}
      <div className="card">
        <div className="ped-head" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Bairros e taxas de entrega</h3>
          <button type="button" className="btn-primario" onClick={() => setEditando({})}>+ Bairros</button>
        </div>
        <p className="form-hint" style={{ marginTop: 0 }}>O cliente informa o endereço e o site cobra a taxa do bairro. O nome é comparado sem acento e sem diferenciar maiúsculas.</p>
        {!lista ? <p className="muted">Carregando…</p> : lista.length === 0 ? <Vazio>Nenhum bairro cadastrado.</Vazio> : (
          <div className="tabela-wrap">
            <table className="tabela-cartoes">
              <thead><tr><th>Bairro</th><th className="num">Taxa</th><th className="num">Tempo a mais</th><th className="num">Pedido mínimo</th><th /></tr></thead>
              <tbody>
                {lista.map((r) => (
                  <tr key={r.id} style={{ opacity: r.ativo ? 1 : 0.55 }}>
                    <td><b>{r.nome}</b>{!r.ativo && <span className="badge-inativo"> pausado</span>}</td>
                    <td className="num">{Number(r.taxa) === 0 ? 'Grátis' : brl(r.taxa)}</td>
                    <td className="num">{r.tempo_extra_min ? `+${r.tempo_extra_min} min` : '—'}</td>
                    <td className="num">{r.pedido_minimo === null ? 'o da loja' : brl(r.pedido_minimo)}</td>
                    <td className="num lv-acoes-linha">
                      <button type="button" className="btn-link" onClick={() => setEditando(r)}>Editar</button>
                      <button type="button" className="btn-link perigo" onClick={() => remover(r)}>Remover</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <form className="card form-stack" onSubmit={salvarOutros}>
        <h3 style={{ margin: 0 }}>Outros bairros</h3>
        <label className="check"><input type="checkbox" checked={outros.ligado} onChange={(e) => setOutros({ ...outros, ligado: e.target.checked })} /> Entregar também em bairros fora da lista</label>
        {outros.ligado && <Field label="Taxa para qualquer outro bairro (R$)"><input inputMode="decimal" value={outros.taxa} onChange={(e) => setOutros({ ...outros, taxa: e.target.value })} placeholder="0,00" style={{ maxWidth: 180 }} /></Field>}
        {!outros.ligado && <p className="form-hint" style={{ margin: 0 }}>Desligado: endereço em bairro fora da lista recebe o aviso “não fazemos entrega neste bairro”.</p>}
        <div><button type="submit">Salvar</button></div>
      </form>
      {editando && <RegiaoModal r={editando} onClose={() => setEditando(null)} onSalvo={async () => { setEditando(null); await carregar(); await onMudou(); }} />}
    </div>
  );
}

function RegiaoModal({ r, onClose, onSalvo }) {
  const toast = useToast();
  const novo = !r.id;
  const [f, setF] = useState({ nomes: '', nome: r.nome || '', taxa: valor(r.taxa ?? ''), tempo_extra_min: String(r.tempo_extra_min || 0), pedido_minimo: valor(r.pedido_minimo), ativo: r.ativo !== false });
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function salvar(e) {
    e.preventDefault();
    const corpo = { taxa: parseNumero(f.taxa) || 0, tempo_extra_min: Number(f.tempo_extra_min) || 0, pedido_minimo: f.pedido_minimo.trim() ? parseNumero(f.pedido_minimo) : null, ativo: f.ativo };
    try {
      if (novo) {
        const res = await api.post('/loja-virtual/regioes', { ...corpo, nomes: f.nomes });
        toast.sucesso(res.criados ? `${res.criados} bairro(s) cadastrado(s)` : 'Esses bairros já estavam na lista');
      } else {
        await api.put(`/loja-virtual/regioes/${r.id}`, { ...corpo, nome: f.nome });
        toast.sucesso('Bairro salvo');
      }
      await onSalvo();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo={novo ? 'Cadastrar bairros' : `Editar ${r.nome}`} onClose={onClose}>
      <form className="form-stack" onSubmit={salvar}>
        {novo
          ? <Field label="Bairros *" hint="Um por linha: todos recebem a mesma taxa (depois dá para editar um a um)."><textarea rows={5} autoFocus value={f.nomes} onChange={mudar('nomes')} placeholder={'Centro\nJardim América\nVila Nova'} required /></Field>
          : <Field label="Bairro *"><input autoFocus value={f.nome} onChange={mudar('nome')} maxLength={80} required /></Field>}
        <div className="form-grid lv-grid-3">
          <Field label="Taxa (R$)"><input inputMode="decimal" value={f.taxa} onChange={mudar('taxa')} placeholder="0,00 = grátis" /></Field>
          <Field label="Tempo a mais (min)"><input inputMode="numeric" value={f.tempo_extra_min} onChange={mudar('tempo_extra_min')} /></Field>
          <Field label="Pedido mínimo (R$)"><input inputMode="decimal" value={f.pedido_minimo} onChange={mudar('pedido_minimo')} placeholder="o da loja" /></Field>
        </div>
        {!novo && <label className="check"><input type="checkbox" checked={f.ativo} onChange={mudar('ativo')} /> Entregando neste bairro</label>}
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button type="submit" className="btn-primario">Salvar</button></div>
      </form>
    </Modal>
  );
}

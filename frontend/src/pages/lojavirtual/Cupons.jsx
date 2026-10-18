import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';
import { Field, Modal, Vazio } from '../../components/ui.jsx';
import { brl, parseNumero } from '../../utils/format';

const diaBR = (d) => (d ? d.split('-').reverse().join('/') : '');
const valor = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
const hoje = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

function descricaoDoCupom(c) {
  const d = c.tipo === 'frete_gratis' ? 'Frete grátis' : c.tipo === 'valor' ? `${brl(c.valor)} de desconto` : `${String(c.valor).replace('.', ',')}% de desconto${c.desconto_maximo ? ` (até ${brl(c.desconto_maximo)})` : ''}`;
  const regras = [
    Number(c.pedido_minimo) > 0 ? `pedido a partir de ${brl(c.pedido_minimo)}` : null,
    c.primeira_compra ? 'só na primeira compra' : null,
    c.limite_por_cliente ? `${c.limite_por_cliente}x por cliente` : null,
    c.limite_total ? `${c.limite_total} usos no total` : null,
  ].filter(Boolean);
  return `${d}${regras.length ? ` · ${regras.join(' · ')}` : ''}`;
}
function situacao(c) {
  if (!c.ativo) return ['', 'Desativado'];
  if (c.fim && c.fim < hoje()) return ['', 'Vencido'];
  if (c.inicio && c.inicio > hoje()) return ['warn', `Começa ${diaBR(c.inicio)}`];
  if (c.limite_total && c.usos >= c.limite_total) return ['', 'Esgotado'];
  return ['ok', 'Valendo'];
}

export default function Cupons() {
  const toast = useToast();
  const confirmar = useConfirm();
  const [lista, setLista] = useState(null);
  const [editando, setEditando] = useState(null);
  const carregar = useCallback(() => api.get('/loja-virtual/cupons').then(setLista).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  async function remover(c) {
    if (!(await confirmar({ titulo: `Remover o cupom ${c.codigo}?`, mensagem: c.usos > 0 ? 'Ele já foi usado: fica desativado (o histórico dos pedidos continua).' : 'O cupom deixa de existir.', confirmar: 'Remover', perigo: true }))) return;
    try { const r = await api.del(`/loja-virtual/cupons/${c.id}`); toast.sucesso(r.desativado ? 'Cupom desativado' : 'Cupom removido'); await carregar(); } catch (err) { toast.erro(err); }
  }
  return (
    <div className="card">
      <div className="ped-head" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Cupons de desconto</h3>
        <button type="button" className="btn-primario" onClick={() => setEditando({})}>+ Novo cupom</button>
      </div>
      <p className="form-hint" style={{ marginTop: 0 }}>O cliente digita o código no carrinho do site. O desconto aparece no pedido e na venda.</p>
      {!lista ? <p className="muted">Carregando…</p> : lista.length === 0 ? <Vazio>Nenhum cupom ainda.</Vazio> : (
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Código</th><th>Regra</th><th>Validade</th><th className="num">Usos</th><th className="num">Desconto dado</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {lista.map((c) => {
                const [cls, txt] = situacao(c);
                return (
                  <tr key={c.id}>
                    <td><code className="lv-codigo">{c.codigo}</code>{c.descricao && <div className="celula-sub">{c.descricao}</div>}</td>
                    <td>{descricaoDoCupom(c)}</td>
                    <td>{c.inicio || c.fim ? `${c.inicio ? diaBR(c.inicio) : '…'} a ${c.fim ? diaBR(c.fim) : '…'}` : 'sem prazo'}</td>
                    <td className="num">{c.usos}{c.limite_total ? ` / ${c.limite_total}` : ''}</td>
                    <td className="num">{brl(c.desconto_total)}</td>
                    <td><span className={`ped-pill ${cls}`}>{txt}</span></td>
                    <td className="num lv-acoes-linha">
                      <button type="button" className="btn-link" onClick={() => setEditando(c)}>Editar</button>
                      <button type="button" className="btn-link perigo" onClick={() => remover(c)}>Remover</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editando && <CupomModal c={editando} onClose={() => setEditando(null)} onSalvo={async () => { setEditando(null); await carregar(); }} />}
    </div>
  );
}

function CupomModal({ c, onClose, onSalvo }) {
  const toast = useToast();
  const novo = !c.id;
  const [f, setF] = useState({
    codigo: c.codigo || '', descricao: c.descricao || '', tipo: c.tipo || 'percentual', valor: valor(c.valor), desconto_maximo: valor(c.desconto_maximo),
    pedido_minimo: Number(c.pedido_minimo) > 0 ? valor(c.pedido_minimo) : '', inicio: c.inicio || '', fim: c.fim || '',
    limite_total: c.limite_total ? String(c.limite_total) : '', limite_por_cliente: novo ? '1' : c.limite_por_cliente ? String(c.limite_por_cliente) : '',
    primeira_compra: !!c.primeira_compra, ativo: c.ativo !== false,
  });
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function salvar(e) {
    e.preventDefault();
    const corpo = {
      codigo: f.codigo, descricao: f.descricao, tipo: f.tipo, valor: f.tipo === 'frete_gratis' ? 0 : parseNumero(f.valor),
      desconto_maximo: f.tipo === 'percentual' && f.desconto_maximo.trim() ? parseNumero(f.desconto_maximo) : null,
      pedido_minimo: f.pedido_minimo.trim() ? parseNumero(f.pedido_minimo) : 0, inicio: f.inicio || null, fim: f.fim || null,
      limite_total: f.limite_total.trim() ? Number(f.limite_total) : null, limite_por_cliente: f.limite_por_cliente.trim() ? Number(f.limite_por_cliente) : null,
      primeira_compra: f.primeira_compra, ativo: f.ativo,
    };
    try {
      if (novo) await api.post('/loja-virtual/cupons', corpo); else await api.put(`/loja-virtual/cupons/${c.id}`, corpo);
      toast.sucesso(novo ? 'Cupom criado' : 'Cupom salvo');
      await onSalvo();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo={novo ? 'Novo cupom' : `Cupom ${c.codigo}`} onClose={onClose} largura="larga">
      <form className="form-stack" onSubmit={salvar}>
        <div className="form-grid">
          <Field label="Código *" hint="Letras e números, sem espaço."><input autoFocus value={f.codigo} onChange={(e) => setF({ ...f, codigo: e.target.value.toUpperCase().replace(/\s/g, '') })} maxLength={30} placeholder="BEMVINDO10" required /></Field>
          <Field label="Descrição (interna)"><input value={f.descricao} onChange={mudar('descricao')} maxLength={200} placeholder="Campanha de inauguração" /></Field>
        </div>
        <div className="form-grid lv-grid-3">
          <Field label="Tipo">
            <select value={f.tipo} onChange={mudar('tipo')}>
              <option value="percentual">Porcentagem</option>
              <option value="valor">Valor em R$</option>
              <option value="frete_gratis">Frete grátis</option>
            </select>
          </Field>
          {f.tipo !== 'frete_gratis' && <Field label={f.tipo === 'percentual' ? 'Desconto (%)' : 'Desconto (R$)'}><input inputMode="decimal" value={f.valor} onChange={mudar('valor')} required /></Field>}
          {f.tipo === 'percentual' && <Field label="Desconto máximo (R$)"><input inputMode="decimal" value={f.desconto_maximo} onChange={mudar('desconto_maximo')} placeholder="sem teto" /></Field>}
        </div>
        <div className="form-grid lv-grid-3">
          <Field label="Pedido mínimo (R$)"><input inputMode="decimal" value={f.pedido_minimo} onChange={mudar('pedido_minimo')} placeholder="qualquer valor" /></Field>
          <Field label="Vale de"><input type="date" value={f.inicio} onChange={mudar('inicio')} /></Field>
          <Field label="até"><input type="date" value={f.fim} onChange={mudar('fim')} /></Field>
        </div>
        <div className="form-grid">
          <Field label="Usos no total" hint="Vazio = sem limite"><input inputMode="numeric" value={f.limite_total} onChange={mudar('limite_total')} /></Field>
          <Field label="Usos por cliente" hint="Vazio = sem limite (com limite, o cliente precisa estar logado)"><input inputMode="numeric" value={f.limite_por_cliente} onChange={mudar('limite_por_cliente')} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.primeira_compra} onChange={mudar('primeira_compra')} /> Só na primeira compra do cliente</label>
        {!novo && <label className="check"><input type="checkbox" checked={f.ativo} onChange={mudar('ativo')} /> Cupom ativo</label>}
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button type="submit" className="btn-primario">Salvar</button></div>
      </form>
    </Modal>
  );
}

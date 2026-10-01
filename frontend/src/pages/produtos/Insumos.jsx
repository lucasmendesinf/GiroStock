import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast, useConfirm } from '../../context/UiContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { Field, Modal, Vazio } from '../../components/ui.jsx';
import { brl, brlFino, dataHora, parseNumero, qtd } from '../../utils/format';
import { UNIDADES_INSUMO } from './comum.jsx';
import { pode } from '../../utils/permissions.js';

const ACOES = [
  { id: 'entrada', label: 'Entrada' },
  { id: 'saida', label: 'Saída' },
  { id: 'transferencia', label: 'Transferir' },
  { id: 'balanco', label: 'Balanço' },
  { id: 'minimo', label: 'Mínimo' },
];

export default function Insumos({ ingredients, locations, reload }) {
  const toast = useToast();
  const { user } = useAuth();
  const locaisAtivos = locations.filter((l) => l.ativo);
  const [novo, setNovo] = useState(false);
  const [movimentando, setMovimentando] = useState(null);
  const [editandoInsumo, setEditandoInsumo] = useState(null);
  const podeCriar = pode(user, 'insumos.criar');
  const podeEditar = pode(user, 'insumos.editar');
  const podeMovimentar = pode(user, 'estoque.movimentar') || podeEditar;
  const [consumo, setConsumo] = useState([]);

  useEffect(() => {
    api.get('/consumption-feed').then(setConsumo).catch((err) => toast.erro(err));
  }, [toast, ingredients]);

  return (
    <div>
      <div>
        <div className="toolbar">
          <span className="muted">Matéria-prima usada nas fichas técnicas (lanches, porções, combos). Cada loja tem o próprio saldo.</span>
          <span className="toolbar-espaco" />
          {podeCriar && <button type="button" className="btn-primario" onClick={() => setNovo(true)}>+ Novo insumo</button>}
        </div>
        <div className="card">
          <div className="tabela-wrap">
            <table>
              <thead><tr><th>Insumo</th><th className="num col-opcional">Custo/un</th><th className="num">Saldo total</th><th className="col-opcional">Por loja</th><th /></tr></thead>
              <tbody>
                {ingredients.map((i) => (
                  <tr key={i.id}>
                    <td className={i.ativo ? '' : 'row-inativa-cel'}><div className="celula-principal">{i.nome} {!i.ativo && <span className="badge-inativo">inativo</span>}</div><div className="celula-sub">{i.unidade} · valor em estoque {brl(Number(i.saldo_total) * Number(i.custo_unitario))}</div></td>
                    <td className="num col-opcional">{brlFino(i.custo_unitario)}/{i.unidade}</td>
                    <td className="num">{qtd(i.saldo_total)} {i.unidade}</td>
                    <td className="col-opcional">
                      <div className="chips">
                        {i.saldos_por_local.length === 0 && <span className="muted">sem saldo</span>}
                        {i.saldos_por_local.map((s) => (
                          <span key={s.location_id} className={s.abaixo_minimo ? 'badge-alerta' : 'badge-local'}>
                            {s.location_nome}: {qtd(s.saldo)}{Number(s.estoque_minimo) > 0 ? ` (mín. ${qtd(s.estoque_minimo)})` : ''}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div className="row-actions">
                        {podeMovimentar && <button type="button" className="btn-link" onClick={() => setMovimentando(i)}>Movimentar</button>}
                        {podeEditar && <button type="button" className="btn-link" onClick={() => setEditandoInsumo(i)}>Editar</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ingredients.length === 0 && <Vazio>Nenhum insumo cadastrado ainda.</Vazio>}
        </div>
      </div>

      <div>
        <div className="card">
          <h3>Consumo recente por vendas</h3>
          {consumo.length === 0 && <Vazio>Nenhum consumo registrado ainda.</Vazio>}
          <ul className="lista-simples">
            {consumo.map((c) => (
              <li key={c.sale_item_id} style={{ flexDirection: 'column', gap: '2px' }}>
                <span><strong>{qtd(c.quantidade_vendida)}x {c.product_nome}</strong>{c.location_nome ? <span className="muted"> · {c.location_nome}</span> : ''}</span>
                <span className="muted">{c.insumos.map((ins) => `${ins.nome} ${qtd(ins.quantidade)}${ins.unidade}`).join(', ')}</span>
                <span className="muted">{dataHora(c.criado_em)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {novo && <NovoInsumo locaisAtivos={locaisAtivos} user={user} reload={reload} onClose={() => setNovo(false)} />}
      {editandoInsumo && <EditarInsumo insumo={editandoInsumo} reload={reload} onClose={() => setEditandoInsumo(null)} />}
      {movimentando && (
        <MovimentarInsumo insumo={ingredients.find((i) => i.id === movimentando.id) || movimentando}
          locaisAtivos={locaisAtivos} user={user} reload={reload} onClose={() => setMovimentando(null)} />
      )}
    </div>
  );
}

function localInicial(user, locaisAtivos, insumo) {
  if (user.locationId && locaisAtivos.some((l) => l.id === user.locationId)) return user.locationId;
  // Sem loja fixa: comeca na loja com mais saldo desse insumo.
  const comSaldo = (insumo ? insumo.saldos_por_local : []).slice().sort((a, b) => Number(b.saldo) - Number(a.saldo))
    .find((s) => locaisAtivos.some((l) => l.id === s.location_id));
  return comSaldo ? comSaldo.location_id : (locaisAtivos[0] && locaisAtivos[0].id) || '';
}

function NovoInsumo({ locaisAtivos, user, reload, onClose }) {
  const toast = useToast();
  const [form, setForm] = useState({ nome: '', unidade: 'G', estoque_inicial: '', custo_total: '', location_id: localInicial(user, locaisAtivos, null) });
  async function salvar(e) {
    e.preventDefault();
    const inicial = parseNumero(form.estoque_inicial || '0');
    try {
      await api.post('/ingredients', {
        nome: form.nome, unidade: form.unidade, estoque_inicial: inicial,
        custo_total: form.custo_total === '' ? 0 : parseNumero(form.custo_total),
        location_id: inicial > 0 ? form.location_id : null,
      });
      toast.sucesso('Insumo cadastrado.');
      await reload();
      onClose();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo="Novo insumo" onClose={onClose}>
      <form onSubmit={salvar} className="form-stack">
        <Field label="Nome *"><input autoFocus value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex: Queijo mussarela" required /></Field>
        <div className="form-grid">
          <Field label="Unidade" style={{ flex: '0 0 110px' }}>
            <select value={form.unidade} onChange={(e) => setForm({ ...form, unidade: e.target.value })}>
              {UNIDADES_INSUMO.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
          <Field label="Estoque inicial"><input inputMode="decimal" value={form.estoque_inicial} onChange={(e) => setForm({ ...form, estoque_inicial: e.target.value })} placeholder="0" /></Field>
        </div>
        <Field label="Loja do estoque inicial">
          <select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
            {locaisAtivos.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
          </select>
        </Field>
        <Field label="Custo total pago por essa quantidade (R$)" hint="Ex: R$ 50,00 por 1000 g de queijo → o sistema calcula o custo por grama.">
          <input inputMode="decimal" value={form.custo_total} onChange={(e) => setForm({ ...form, custo_total: e.target.value })} placeholder="0,00" />
        </Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit">Cadastrar insumo</button>
        </div>
      </form>
    </Modal>
  );
}

function MovimentarInsumo({ insumo, locaisAtivos, user, reload, onClose }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const podeEditar = pode(user, 'insumos.editar');
  const podeMovimentar = pode(user, 'estoque.movimentar');
  const acoes = ACOES.filter((a) => (a.id === 'minimo' ? podeEditar : podeMovimentar));
  const [acao, setAcao] = useState(acoes[0] ? acoes[0].id : 'entrada');
  const [local, setLocal] = useState(localInicial(user, locaisAtivos, insumo));
  const [form, setForm] = useState({ quantidade: '', custo_total: '', destino: '', novo_saldo: '', novo_custo: '', minimo: '', motivo: '' });
  const saldoAqui = Number((insumo.saldos_por_local.find((s) => s.location_id === local) || { saldo: 0 }).saldo);
  const minimoAqui = Number((insumo.saldos_por_local.find((s) => s.location_id === local) || { estoque_minimo: 0 }).estoque_minimo);

  useEffect(() => {
    setForm((f) => ({ ...f, novo_saldo: String(saldoAqui).replace('.', ','), minimo: String(minimoAqui).replace('.', ',') }));
  }, [local, saldoAqui, minimoAqui]);

  async function executar(e) {
    e.preventDefault();
    const base = `/ingredients/${insumo.id}`;
    try {
      if (acao === 'entrada') {
        const payload = { quantidade: parseNumero(form.quantidade), location_id: local };
        if (form.custo_total !== '') payload.custo_total = parseNumero(form.custo_total);
        await api.post(`${base}/stock-entries`, payload);
      } else if (acao === 'saida') {
        await api.post(`${base}/stock-exits`, { quantidade: parseNumero(form.quantidade), location_id: local, motivo: form.motivo });
      } else if (acao === 'transferencia') {
        await api.post(`${base}/transfers`, { quantidade: parseNumero(form.quantidade), location_origem_id: local, location_destino_id: form.destino, motivo: form.motivo });
      } else if (acao === 'balanco') {
        const novo = parseNumero(form.novo_saldo);
        if (novo === 0 && saldoAqui > 0 && !(await confirmar({ titulo: `Zerar ${insumo.nome} nesta loja?`, mensagem: `O saldo de ${qtd(saldoAqui)} ${insumo.unidade} vai para zero.`, confirmar: 'Zerar', perigo: true }))) return;
        const payload = { novo_saldo: novo, location_id: local, motivo: form.motivo };
        if (form.novo_custo !== '') payload.novo_custo_unitario = parseNumero(form.novo_custo);
        await api.post(`${base}/stock-adjustment`, payload);
      } else if (acao === 'minimo') {
        await api.put(`${base}/minimum`, { location_id: local, estoque_minimo: parseNumero(form.minimo || '0') });
      }
      toast.sucesso('Insumo atualizado.');
      setForm({ quantidade: '', custo_total: '', destino: '', novo_saldo: '', novo_custo: '', minimo: '', motivo: '' });
      await reload();
    } catch (err) { toast.erro(err); }
  }

  const precisaMotivo = ['saida', 'transferencia', 'balanco'].includes(acao);
  return (
    <Modal titulo={`Movimentar ${insumo.nome}`} subtitulo={`Custo atual ${brlFino(insumo.custo_unitario)}/${insumo.unidade} · saldo total ${qtd(insumo.saldo_total)} ${insumo.unidade}`} onClose={onClose} largura="larga">
      <div className="segmentado">
        {acoes.map((a) => <button key={a.id} type="button" className={acao === a.id ? 'ativo' : ''} onClick={() => setAcao(a.id)}>{a.label}</button>)}
      </div>
      <form onSubmit={executar} className="form-stack">
        <div className="form-grid">
          <Field label={acao === 'transferencia' ? 'De (origem)' : 'Loja'} hint={`Saldo nesta loja: ${qtd(saldoAqui)} ${insumo.unidade}`}>
            <select value={local} onChange={(e) => setLocal(e.target.value)}>
              {locaisAtivos.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
            </select>
          </Field>
          {acao === 'transferencia' && (
            <Field label="Para (destino) *">
              <select value={form.destino} onChange={(e) => setForm({ ...form, destino: e.target.value })} required>
                <option value="">Escolha...</option>
                {locaisAtivos.filter((l) => l.id !== local).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
              </select>
            </Field>
          )}
        </div>

        {['entrada', 'saida', 'transferencia'].includes(acao) && (
          <div className="form-grid">
            <Field label={`Quantidade (${insumo.unidade}) *`}><input inputMode="decimal" autoFocus value={form.quantidade} onChange={(e) => setForm({ ...form, quantidade: e.target.value })} required /></Field>
            {acao === 'entrada' && (
              <Field label="Custo total pago (R$)" hint="Opcional: atualiza o custo médio"><input inputMode="decimal" value={form.custo_total} onChange={(e) => setForm({ ...form, custo_total: e.target.value })} placeholder="0,00" /></Field>
            )}
          </div>
        )}

        {acao === 'balanco' && (
          <div className="form-grid">
            <Field label={`Saldo contado (${insumo.unidade}) *`} hint={`Hoje: ${qtd(saldoAqui)}. Use 0 para zerar.`}>
              <input inputMode="decimal" value={form.novo_saldo} onChange={(e) => setForm({ ...form, novo_saldo: e.target.value })} required />
            </Field>
            {podeEditar && <Field label={`Novo custo por ${insumo.unidade} (opcional)`}><input inputMode="decimal" value={form.novo_custo} onChange={(e) => setForm({ ...form, novo_custo: e.target.value })} placeholder={brlFino(insumo.custo_unitario)} /></Field>}
          </div>
        )}

        {acao === 'minimo' && (
          <Field label={`Estoque mínimo nesta loja (${insumo.unidade})`} hint="Abaixo disso o insumo aparece nos alertas. Use 0 para desligar.">
            <input inputMode="decimal" value={form.minimo} onChange={(e) => setForm({ ...form, minimo: e.target.value })} />
          </Field>
        )}

        {precisaMotivo && (
          <Field label="Motivo *"><input value={form.motivo} onChange={(e) => setForm({ ...form, motivo: e.target.value })} placeholder="Ex: perda, validade, contagem, abastecer lanchonete" required minLength={3} /></Field>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Fechar</button>
          <button type="submit">Confirmar</button>
        </div>
      </form>
    </Modal>
  );
}

// Edicao do insumo (nome, unidade, custo por unidade) e ativar/desativar.
function EditarInsumo({ insumo, reload, onClose }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [form, setForm] = useState({
    nome: insumo.nome, unidade: insumo.unidade, custo_unitario: String(Number(insumo.custo_unitario)).replace('.', ','),
  });
  const unidades = UNIDADES_INSUMO.includes(insumo.unidade) ? UNIDADES_INSUMO : [insumo.unidade, ...UNIDADES_INSUMO];

  async function salvar(e) {
    e.preventDefault();
    try {
      await api.put(`/ingredients/${insumo.id}`, { nome: form.nome, unidade: form.unidade, custo_unitario: parseNumero(form.custo_unitario) });
      toast.sucesso('Insumo atualizado.');
      await reload();
      onClose();
    } catch (err) { toast.erro(err); }
  }

  async function alternarStatus() {
    if (insumo.ativo && !(await confirmar({
      titulo: `Desativar ${insumo.nome}?`,
      mensagem: 'Ele deixa de aparecer para novas fichas técnicas. As fichas que já usam o insumo continuam funcionando.',
      confirmar: 'Desativar', perigo: true,
    }))) return;
    try {
      await api.patch(`/ingredients/${insumo.id}/status`, { ativo: !insumo.ativo });
      toast.sucesso(insumo.ativo ? 'Insumo desativado.' : 'Insumo reativado.');
      await reload();
      onClose();
    } catch (err) { toast.erro(err); }
  }

  return (
    <Modal titulo={`Editar ${insumo.nome}`} onClose={onClose}>
      <form onSubmit={salvar} className="form-stack">
        <Field label="Nome *"><input autoFocus value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required minLength={2} /></Field>
        <div className="form-grid">
          <Field label="Unidade" style={{ flex: '0 0 120px' }} hint="Só muda sem saldo e fora de fichas.">
            <select value={form.unidade} onChange={(e) => setForm({ ...form, unidade: e.target.value })}>
              {unidades.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
          <Field label={`Custo por ${form.unidade} (R$)`} hint="Usado no custo das fichas técnicas.">
            <input inputMode="decimal" value={form.custo_unitario} onChange={(e) => setForm({ ...form, custo_unitario: e.target.value })} required />
          </Field>
        </div>
        <div className="modal-actions">
          <button type="button" className={insumo.ativo ? 'perigo' : ''} onClick={alternarStatus}>{insumo.ativo ? 'Desativar' : 'Reativar'}</button>
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit">Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

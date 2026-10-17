import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';
import { Field } from '../../components/ui.jsx';
import { ListaModulos, alternarModulo, resumoModulos, useCatalogoModulos } from './Modulos.jsx';

const ROTULO_STATUS = { ok: ['ok', 'Operando'], erro: ['err', 'Com problema'], nao_configurado: ['warn', 'Não configurado'], nao_contratado: ['warn', 'Não contratado'], futuro: ['warn', 'Etapa futura'], indisponivel: ['warn', 'Indisponível'] };

export default function Config() {
  return (
    <div>
      <div className="ped-head" style={{ marginTop: 6 }}><h3 style={{ margin: 0 }}>Configurações globais</h3></div>
      <Integracoes />
      <Aviso />
      <Manutencao />
      <Parametros />
      <Planos />
    </div>
  );
}

function Integracoes() {
  const toast = useToast();
  const [lista, setLista] = useState(null);
  const [testando, setTestando] = useState('');
  const carregar = useCallback(() => api.get('/master/config/integracoes').then((r) => setLista(r.integracoes)).catch((e) => toast.erro(e)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  async function testar(i) {
    setTestando(i.id);
    try { const r = await api.post(`/master/config/integracoes/${i.id}/testar`); (r.ok ? toast.sucesso : toast.erro)(r.mensagem); } catch (e) { toast.erro(e); } finally { setTestando(''); }
  }
  return (
    <div className="card">
      <h4 style={{ margin: '0 0 8px' }}>Integrações</h4>
      <p className="cl-sub" style={{ margin: '0 0 8px' }}>Só o estado de cada uma: chaves e senhas nunca aparecem aqui.</p>
      {lista ? lista.map((i) => {
        const [cls, rotulo] = ROTULO_STATUS[i.status] || ['warn', i.status];
        return (
          <div key={i.id} className="vg-linha" style={{ alignItems: 'center', borderTop: '1px solid var(--line)' }}>
            <span><b style={{ color: 'var(--ivory)' }}>{i.nome}</b><span className="cl-sub">{i.detalhe}</span></span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className={`ped-pill ${cls}`}>{rotulo}</span>
              {i.testavel && <button type="button" className="btn-link" disabled={testando === i.id} onClick={() => testar(i)}>{testando === i.id ? 'Testando…' : 'Testar'}</button>}
            </span>
          </div>
        );
      }) : <p className="muted">Carregando…</p>}
    </div>
  );
}

function Aviso() {
  const toast = useToast();
  const [ativo, setAtivo] = useState(null);
  const [texto, setTexto] = useState('');
  const carregar = useCallback(() => api.get('/master/avisos').then((r) => setAtivo(r.ativo)).catch((e) => toast.erro(e)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  async function publicar(e) {
    e.preventDefault();
    try { await api.post('/master/avisos', { mensagem: texto }); toast.sucesso('Aviso publicado para todos os usuários.'); setTexto(''); carregar(); } catch (err) { toast.erro(err); }
  }
  async function remover() {
    try { await api.del('/master/avisos'); toast.sucesso('Aviso removido.'); carregar(); } catch (err) { toast.erro(err); }
  }
  return (
    <div className="card">
      <h4 style={{ margin: '0 0 8px' }}>Aviso para todos os usuários</h4>
      {ativo && (
        <div className="aviso-faixa" style={{ position: 'static', marginBottom: 10 }}>
          <span>📢 {ativo.mensagem}</span>
          <button type="button" className="btn-link" onClick={remover}>Remover aviso</button>
        </div>
      )}
      <form onSubmit={publicar} className="form-stack" style={{ maxWidth: 560 }}>
        <Field label={ativo ? 'Novo aviso (substitui o atual)' : 'Mensagem do aviso'} hint="De 3 a 300 caracteres. Aparece numa faixa no topo, para todas as empresas; cada usuário pode dispensar.">
          <textarea rows={2} maxLength={300} value={texto} onChange={(e) => setTexto(e.target.value)} />
        </Field>
        {texto.trim().length >= 3 && <div className="aviso-faixa" style={{ position: 'static' }}><span>📢 {texto.trim()}</span><span className="cl-sub" style={{ margin: 0 }}>prévia</span></div>}
        <div><button type="submit" className="btn-primario" disabled={texto.trim().length < 3}>Publicar</button></div>
      </form>
    </div>
  );
}

function Manutencao() {
  const toast = useToast();
  const confirmar = useConfirm();
  const [m, setM] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/master/config/manutencao').then((r) => { setM(r); setMsg(r.mensagem || ''); }).catch((e) => toast.erro(e)); }, [toast]);
  async function alternar() {
    const ligar = !m.ativo;
    if (ligar && !(await confirmar({ titulo: 'Ligar o modo manutenção?', mensagem: 'TODAS as empresas e usuários (menos o Master) ficam sem acesso até você desligar, e quem estiver usando verá a mensagem de manutenção na próxima ação.', confirmar: 'Ligar manutenção', perigo: true }))) return;
    try { setM(await api.put('/master/config/manutencao', { ativo: ligar, mensagem: msg })); toast.sucesso(ligar ? 'Modo manutenção ligado.' : 'Modo manutenção desligado.'); } catch (err) { toast.erro(err); }
  }
  async function salvarMensagem() {
    try { setM(await api.put('/master/config/manutencao', { ativo: m.ativo, mensagem: msg })); toast.sucesso('Mensagem salva.'); } catch (err) { toast.erro(err); }
  }
  if (!m) return null;
  return (
    <div className="card" style={m.ativo ? { borderColor: 'var(--err)' } : undefined}>
      <h4 style={{ margin: '0 0 8px' }}>Modo manutenção</h4>
      <div className="cl-sw" style={{ marginBottom: 8 }}>
        <button type="button" role="switch" aria-checked={m.ativo} aria-label="Modo manutenção" className={m.ativo ? 'on' : ''} onClick={alternar} />
        <span>{m.ativo ? 'LIGADO: as empresas estão sem acesso' : 'Desligado'}<div className="cl-sub">Bloqueia o sistema para todos, menos para você (Master). Use em atualizações e restaurações.</div></span>
      </div>
      <Field label="Mensagem exibida aos usuários"><input value={msg} maxLength={300} onChange={(e) => setMsg(e.target.value)} placeholder="Sistema em manutenção. Voltamos em instantes." /></Field>
      <div style={{ marginTop: 8 }}><button type="button" className="btn-link" onClick={salvarMensagem}>Salvar mensagem</button></div>
    </div>
  );
}

function Parametros() {
  const toast = useToast();
  const [p, setP] = useState(null);
  useEffect(() => { api.get('/master/config/parametros').then(setP).catch((e) => toast.erro(e)); }, [toast]);
  if (!p) return null;
  const campo = (k, v) => setP({ ...p, [k]: v });
  async function salvar(e) {
    e.preventDefault();
    try {
      const corpo = { ...p, vip_limite_padrao: Number(p.vip_limite_padrao), cliente_risco_dias: Number(p.cliente_risco_dias), cliente_inativo_dias: Number(p.cliente_inativo_dias), pedido_atrasado_min: Number(p.pedido_atrasado_min), backup_retencao_dias: Number(p.backup_retencao_dias) };
      setP(await api.put('/master/config/parametros', corpo));
      toast.sucesso('Parâmetros salvos.');
    } catch (err) { toast.erro(err); }
  }
  return (
    <div className="card">
      <h4 style={{ margin: '0 0 8px' }}>Parâmetros padrão</h4>
      <form onSubmit={salvar} className="form-stack" style={{ maxWidth: 560 }}>
        <div className="form-grid">
          <Field label="Cliente “em risco” a partir de (dias)" hint="Dias sem pedir. Padrão: 30"><input type="number" min="1" value={p.cliente_risco_dias} onChange={(e) => campo('cliente_risco_dias', e.target.value)} required /></Field>
          <Field label="Cliente “inativo” a partir de (dias)" hint="Padrão: 60"><input type="number" min="1" value={p.cliente_inativo_dias} onChange={(e) => campo('cliente_inativo_dias', e.target.value)} required /></Field>
          <Field label="Pedido atrasado após (minutos)" hint="Padrão: 25"><input type="number" min="1" value={p.pedido_atrasado_min} onChange={(e) => campo('pedido_atrasado_min', e.target.value)} required /></Field>
          <Field label="Valor VIP inicial (R$)" hint="Só para empresas NOVAS. Padrão: 400"><input type="number" min="0" step="0.01" value={p.vip_limite_padrao} onChange={(e) => campo('vip_limite_padrao', e.target.value)} required /></Field>
          <Field label="Guardar backups automáticos por (dias)" hint="1 a 365. Padrão: 30"><input type="number" min="1" max="365" value={p.backup_retencao_dias} onChange={(e) => campo('backup_retencao_dias', e.target.value)} required /></Field>
          <Field label="Hora do backup automático" hint="Hora do servidor"><input type="time" value={p.backup_hora} onChange={(e) => campo('backup_hora', e.target.value)} required /></Field>
        </div>
        <label className="check-linha"><input type="checkbox" checked={!!p.backup_automatico} onChange={(e) => campo('backup_automatico', e.target.checked)} /> Gerar backup automático todo dia</label>
        <div><button type="submit" className="btn-primario">Salvar parâmetros</button></div>
      </form>
    </div>
  );
}

function Planos() {
  const toast = useToast();
  const confirmar = useConfirm();
  const catalogo = useCatalogoModulos();
  const [lista, setLista] = useState(null);
  const [editando, setEditando] = useState(null); // { novo: bool, codigo, nome, max_*, recursos }
  const carregar = useCallback(() => api.get('/master/planos').then((r) => setLista(r.planos)).catch((e) => toast.erro(e)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  function novoPlano() {
    const recursos = Object.fromEntries((catalogo || []).map((m) => [m.chave, m.chave === 'pdv']));
    setEditando({ novo: true, nome: '', max_lojas: 1, max_usuarios: 3, max_pdvs: 1, recursos });
  }
  async function salvar(e) {
    e.preventDefault();
    const corpo = {
      nome: editando.nome, max_lojas: Number(editando.max_lojas), max_usuarios: Number(editando.max_usuarios), max_pdvs: Number(editando.max_pdvs),
      recursos: Object.fromEntries((catalogo || []).map((m) => [m.chave, !!editando.recursos[m.chave]])),
    };
    try {
      const r = editando.novo ? await api.post('/master/planos', corpo) : await api.put(`/master/planos/${editando.codigo}`, corpo);
      if (r.empresas_acima_do_limite.length > 0) toast.erro(`${r.empresas_acima_do_limite.length} empresa(s) já excedem o novo limite (continuam funcionando, mas não cadastram mais): ${r.empresas_acima_do_limite.slice(0, 3).join(', ')}${r.empresas_acima_do_limite.length > 3 ? '…' : ''}`);
      else toast.sucesso(editando.novo ? `Plano "${r.nome}" criado.` : 'Plano salvo.');
      setEditando(null); carregar();
    } catch (err) { toast.erro(err); }
  }
  async function remover(pl) {
    if (!(await confirmar({ titulo: `Remover o plano "${pl.nome}"?`, confirmar: 'Remover', perigo: true }))) return;
    try { await api.del(`/master/planos/${pl.codigo}`); toast.sucesso('Plano removido.'); carregar(); } catch (err) { toast.erro(err); }
  }
  return (
    <div className="card">
      <div className="ped-head" style={{ margin: '0 0 8px' }}>
        <h4 style={{ margin: 0 }}>Planos</h4>
        <button type="button" className="btn-link" onClick={novoPlano} disabled={!catalogo}>+ Novo plano</button>
      </div>
      <p className="cl-sub" style={{ margin: '0 0 8px' }}>Cada plano define limites e os módulos (segmentos) que o cliente usa. A mudança vale para as empresas sem ajuste próprio. Quem já excede o novo limite continua funcionando; só não consegue cadastrar mais.</p>
      {lista ? (
        <div className="tabela-wrap">
          <table>
            <thead><tr><th>Plano</th><th>Lojas</th><th>Usuários</th><th>PDVs</th><th>Módulos</th><th>Empresas</th><th /></tr></thead>
            <tbody>
              {lista.map((pl) => (
                <tr key={pl.codigo}>
                  <td><b>{pl.nome}</b><span className="cl-sub">{pl.codigo}</span></td>
                  <td>{pl.max_lojas}</td><td>{pl.max_usuarios}</td><td>{pl.max_pdvs}</td>
                  <td style={{ maxWidth: 320 }}>{resumoModulos(catalogo, pl.recursos)}</td>
                  <td>{pl.empresas}{pl.empresas_acima_do_limite.length > 0 && <span className="ped-pill warn" style={{ marginLeft: 6 }}>{pl.empresas_acima_do_limite.length} acima</span>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn-link" onClick={() => setEditando({ ...pl, novo: false, recursos: { ...pl.recursos } })}>Editar</button>
                    {pl.empresas === 0 && <button type="button" className="btn-link perigo" onClick={() => remover(pl)}>Remover</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">Carregando…</p>}
      {editando && (
        <form onSubmit={salvar} className="form-stack" style={{ maxWidth: 640, marginTop: 12 }}>
          <h4 style={{ margin: 0 }}>{editando.novo ? 'Novo plano' : `Editar plano ${editando.codigo}`}</h4>
          <div className="form-grid">
            <Field label="Nome"><input value={editando.nome} onChange={(e) => setEditando({ ...editando, nome: e.target.value })} placeholder="Ex.: Só PDV" required /></Field>
            <Field label="Máx. de lojas"><input type="number" min="1" value={editando.max_lojas} onChange={(e) => setEditando({ ...editando, max_lojas: e.target.value })} required /></Field>
            <Field label="Máx. de usuários"><input type="number" min="1" value={editando.max_usuarios} onChange={(e) => setEditando({ ...editando, max_usuarios: e.target.value })} required /></Field>
            <Field label="Máx. de PDVs"><input type="number" min="0" value={editando.max_pdvs} onChange={(e) => setEditando({ ...editando, max_pdvs: e.target.value })} required /></Field>
          </div>
          <ListaModulos catalogo={catalogo} valores={editando.recursos}
            onAlternar={(k, v) => { const r = alternarModulo(catalogo, editando.recursos, k, v); setEditando({ ...editando, recursos: r.valores }); if (r.junto.length) toast.sucesso(`Junto: ${r.junto.join(', ')} ${v ? 'ligado' : 'desligado'}`); }} />
          <div className="modal-actions" style={{ justifyContent: 'flex-start' }}><button type="button" onClick={() => setEditando(null)}>Cancelar</button><button type="submit">{editando.novo ? 'Criar plano' : 'Salvar plano'}</button></div>
        </form>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Modal } from '../../components/ui.jsx';
import { gerarSenha, quando } from './util.js';
import SenhaUnicaModal from './SenhaUnicaModal.jsx';
import NovoUsuarioModal from './NovoUsuarioModal.jsx';

const NOME_LIMITE = { lojas: 'Lojas', usuarios: 'Usuários', pdvs: 'PDVs' };

export default function Empresas() {
  const toast = useToast();
  const [dados, setDados] = useState(null);
  const [busca, setBusca] = useState('');
  const [ficha, setFicha] = useState(null);
  const [nova, setNova] = useState(false);
  const [criada, setCriada] = useState(null); // resposta da criacao (senha temporaria, uma unica vez)
  const [suspender, setSuspender] = useState(null);
  const [novoUsuario, setNovoUsuario] = useState(null); // id da empresa

  const carregar = useCallback(async () => {
    try { setDados(await api.get('/master/empresas')); } catch (err) { toast.erro(err); }
  }, [toast]);
  useEffect(() => { carregar(); }, [carregar]);

  const abrir = useCallback(async (id) => {
    try { setFicha(await api.get(`/master/empresas/${id}`)); } catch (err) { toast.erro(err); }
  }, [toast]);
  async function atualizarFicha(id) { await carregar(); await abrir(id); }

  const lista = useMemo(() => {
    if (!dados) return [];
    const t = busca.trim().toLowerCase();
    return dados.empresas.filter((e) => !t || e.nome.toLowerCase().includes(t) || (e.documento || '').includes(t.replace(/\D/g, '') || '§'));
  }, [dados, busca]);

  async function alternarRecurso(chave) {
    try {
      await api.patch(`/master/empresas/${ficha.id}`, { recursos: { [chave]: !ficha.recursos[chave] } });
      toast.sucesso(`Recurso ${chave} ${!ficha.recursos[chave] ? 'liberado' : 'bloqueado'} para ${ficha.nome}`);
      await atualizarFicha(ficha.id);
    } catch (err) { toast.erro(err); }
  }
  async function trocarPlano(plano) {
    try { await api.patch(`/master/empresas/${ficha.id}`, { plano }); toast.sucesso('Plano alterado'); await atualizarFicha(ficha.id); } catch (err) { toast.erro(err); }
  }
  async function reativar() {
    try { await api.post(`/master/empresas/${ficha.id}/reativar`); toast.sucesso(`${ficha.nome} reativada`); await atualizarFicha(ficha.id); } catch (err) { toast.erro(err); }
  }

  const r = dados && dados.resumo;
  return (
    <div>
      <div className="ped-head" style={{ marginTop: 6 }}>
        <h3 style={{ margin: 0 }}>Empresas</h3>
        <button type="button" className="btn-primario" onClick={() => setNova(true)}>+ Nova empresa</button>
      </div>

      <div className="ped-kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="ped-kpi"><small>Empresas</small><b>{r ? r.empresas : '—'}</b></div>
        <div className="ped-kpi hero"><small>Ativas</small><b>{r ? r.ativas : '—'}</b></div>
        <div className="ped-kpi"><small>Lojas</small><b>{r ? r.lojas : '—'}</b></div>
        <div className="ped-kpi"><small>Usuários</small><b>{r ? r.usuarios : '—'}</b></div>
      </div>

      <div className="ped-bar">
        <input className="ped-busca" style={{ maxWidth: 340 }} value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar empresa ou CNPJ" aria-label="Buscar empresa" />
      </div>

      <div className="card">
        <div className="tabela-wrap">
          <table>
            <thead><tr><th>Empresa</th><th>Lojas</th><th>Plano</th><th>Situação</th><th className="num">Usuários</th><th>Último acesso</th><th /></tr></thead>
            <tbody>
              {lista.map((e) => (
                <tr key={e.id} className="clicavel" tabIndex={0} onClick={() => abrir(e.id)} onKeyDown={(ev) => { if (ev.key === 'Enter') abrir(e.id); }}>
                  <td><b>{e.nome}</b><div className="cl-sub">{e.documento || '—'}</div></td>
                  <td>{e.qtd_lojas}</td>
                  <td><span className="ped-tag">{e.plano_nome}</span></td>
                  <td><span className={`ped-pill ${e.status === 'ativa' ? 'ok' : 'err'}`}>{e.status === 'ativa' ? 'Ativa' : 'Suspensa'}</span></td>
                  <td className="num">{e.qtd_usuarios_ativos}</td>
                  <td className="cl-sub" style={{ margin: 0 }}>{quando(e.ultimo_acesso)}</td>
                  <td style={{ textAlign: 'right' }} onClick={(ev) => ev.stopPropagation()}>
                    <button type="button" className="btn-link" disabled title="Fase 4 — em breve">Entrar como suporte · em breve</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {dados && lista.length === 0 && <div className="ped-vazio">Nenhuma empresa encontrada</div>}
      </div>

      {ficha && (
        <div className="ped-ov" onMouseDown={(e) => { if (e.target === e.currentTarget) setFicha(null); }}>
          <aside className="ped-drawer" role="dialog" aria-label={`Empresa ${ficha.nome}`}>
            <button type="button" className="modal-close" style={{ float: 'right' }} aria-label="Fechar" onClick={() => setFicha(null)}>×</button>
            <h3>{ficha.nome}</h3>
            <div className="cl-sub">{ficha.documento || 'sem CNPJ'} · cliente desde {new Date(ficha.criado_em).toLocaleDateString('pt-BR')}</div>
            <div style={{ margin: '10px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className={`ped-pill ${ficha.status === 'ativa' ? 'ok' : 'err'}`}>{ficha.status === 'ativa' ? 'Ativa' : 'Suspensa'}</span>
              <select value={ficha.plano} onChange={(e) => trocarPlano(e.target.value)} aria-label="Plano" style={{ width: 'auto' }}>
                <option value="basico">Básico</option>
                <option value="completo">Completo</option>
              </select>
              {ficha.status === 'suspensa' && ficha.suspenso_motivo && <span className="cl-sub" style={{ margin: 0 }}>· {ficha.suspenso_motivo}</span>}
            </div>

            <div className="ped-sec"><span className="ped-rotulo">Lojas</span>
              {ficha.lojas.map((l) => <div key={l.id} className="ped-linha"><span>🏪 {l.nome}</span><span className="ped-tag">{l.ativo ? 'ativa' : 'inativa'}</span></div>)}
            </div>

            <div className="ped-sec"><span className="ped-rotulo">Limites do plano</span>
              {ficha.limites.map((l) => {
                const pct = l.limite > 0 ? Math.min(100, (l.usado / l.limite) * 100) : 100;
                const cor = l.usado >= l.limite ? 'err' : pct >= 80 ? 'warn' : '';
                return (
                  <div key={l.chave}>
                    <div className="ped-linha"><span>{NOME_LIMITE[l.chave]}{l.origem === 'empresa' && <small className="cl-sub" style={{ display: 'inline', marginLeft: 6 }}>personalizado</small>}</span><b>{l.usado} de {l.limite}</b></div>
                    <div className="mt-barra"><i className={cor} style={{ width: `${pct}%` }} /></div>
                  </div>
                );
              })}
            </div>

            <div className="ped-sec"><span className="ped-rotulo">Usuários da empresa</span>
              {ficha.usuarios.length === 0 && <div className="cl-sub">Nenhum usuário</div>}
              {ficha.usuarios.map((u) => (
                <div key={u.id} className="ped-linha"><span>👤 {u.nome} <span className="cl-sub" style={{ display: 'inline' }}>{u.email}</span></span><span className="ped-tag">{u.perfil}{u.ativo ? '' : ' · inativo'}</span></div>
              ))}
              <button type="button" className="btn-link" style={{ marginTop: 8 }} onClick={() => setNovoUsuario(ficha.id)}>+ Usuário nesta empresa</button>
            </div>

            <div className="ped-sec"><span className="ped-rotulo">Recursos liberados</span>
              <div className="cl-sw" style={{ marginBottom: 8 }}>
                <button type="button" role="switch" aria-checked={ficha.recursos.pedidos} className={ficha.recursos.pedidos ? 'on' : ''} onClick={() => alternarRecurso('pedidos')} />
                <span>Pedidos (lanchonete)<div className="cl-sub">{ficha.recursos.origem.pedidos === 'empresa' ? 'definido para esta empresa' : 'segue o plano'}</div></span>
              </div>
              <div className="cl-sw">
                <button type="button" role="switch" aria-checked={ficha.recursos.clientes} className={ficha.recursos.clientes ? 'on' : ''} onClick={() => alternarRecurso('clientes')} />
                <span>Clientes e mensagens<div className="cl-sub">{ficha.recursos.origem.clientes === 'empresa' ? 'definido para esta empresa' : 'segue o plano'}</div></span>
              </div>
            </div>

            <div className="cl-linha-btn" style={{ justifyContent: 'flex-start', marginTop: 18, flexWrap: 'wrap' }}>
              <button type="button" className="btn-link" disabled title="Fase 4 — em breve">Entrar como suporte · em breve</button>
              <button type="button" className="btn-link" disabled title="Fase 3 — em breve">Exportar dados · em breve</button>
              {ficha.status === 'ativa'
                ? <button type="button" className="btn-link perigo" onClick={() => setSuspender(ficha)}>Suspender</button>
                : <button type="button" className="btn-link" onClick={reativar}>Reativar</button>}
            </div>
          </aside>
        </div>
      )}

      {nova && <NovaEmpresaModal onClose={() => setNova(false)} onCriada={(resp) => { setNova(false); setCriada(resp); carregar(); }} />}
      {criada && <SenhaUnicaModal titulo="Empresa criada" resumo={`${criada.empresa.nome} · administrador ${criada.administrador.nome} (${criada.administrador.email})`} senha={criada.senha_temporaria} onClose={() => setCriada(null)} />}
      {suspender && <SuspenderModal empresa={suspender} onClose={() => setSuspender(null)} onFeito={async () => { const id = suspender.id; setSuspender(null); toast.sucesso('Empresa suspensa'); await atualizarFicha(id); }} />}
      {novoUsuario && <NovoUsuarioModal empresaFixa={novoUsuario} onClose={() => setNovoUsuario(null)} onCriado={async () => { const id = novoUsuario; setNovoUsuario(null); await atualizarFicha(id); }} />}
    </div>
  );
}

function SuspenderModal({ empresa, onClose, onFeito }) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  async function confirmar(e) {
    e.preventDefault();
    try { await api.post(`/master/empresas/${empresa.id}/suspender`, { motivo }); onFeito(); } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo={`Suspender ${empresa.nome}?`} subtitulo="Os usuários da empresa perdem o acesso na hora (inclusive sessões abertas)." onClose={onClose}>
      <form className="form-stack" onSubmit={confirmar}>
        <label className="field"><span className="field-label">Motivo *</span><input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: inadimplência" /></label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Voltar</button>
          <button type="submit" disabled={motivo.trim().length < 3}>Suspender empresa</button>
        </div>
      </form>
    </Modal>
  );
}

// Nova empresa em 2 passos: dados da empresa; administrador (criado junto: usuario nunca existe sem empresa).
function NovaEmpresaModal({ onClose, onCriada }) {
  const toast = useToast();
  const [passo, setPasso] = useState(1);
  const [f, setF] = useState({ nome: '', documento: '', plano: 'basico', loja_nome: 'Loja única', admin_nome: '', admin_email: '', senha: gerarSenha() });
  const [salvando, setSalvando] = useState(false);
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.value });

  function proximo() {
    if (f.nome.trim().length < 2) { toast.erro('Informe o nome da empresa'); return; }
    setPasso(2);
  }
  async function criar(e) {
    e.preventDefault();
    if (!f.admin_nome.trim()) { toast.erro('Informe o nome do administrador'); return; }
    if (!/^\S+@\S+\.\S+$/.test(f.admin_email)) { toast.erro('Informe um e-mail válido'); return; }
    setSalvando(true);
    try {
      const resp = await api.post('/master/empresas', {
        nome: f.nome, documento: f.documento, plano: f.plano, loja_nome: f.loja_nome,
        admin: { nome: f.admin_nome, email: f.admin_email, senha: f.senha },
      });
      onCriada(resp);
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  return (
    <Modal titulo="Nova empresa" onClose={salvando ? undefined : onClose} largura="larga">
      <div className="mt-passos"><span className={passo === 1 ? 'on' : 'ok'}>1 · Dados da empresa</span><span className={passo === 2 ? 'on' : ''}>2 · Administrador</span></div>
      {passo === 1 ? (
        <div className="form-stack">
          <label className="field"><span className="field-label">Razão / nome da empresa</span><input autoFocus value={f.nome} onChange={mudar('nome')} /></label>
          <label className="field"><span className="field-label">CNPJ</span><input value={f.documento} onChange={mudar('documento')} placeholder="00.000.000/0000-00" /></label>
          <div className="form-grid">
            <label className="field"><span className="field-label">Plano</span>
              <select value={f.plano} onChange={mudar('plano')}><option value="basico">Básico</option><option value="completo">Completo</option></select>
            </label>
            <label className="field"><span className="field-label">Primeira loja</span><input value={f.loja_nome} onChange={mudar('loja_nome')} /></label>
          </div>
          <div className="ped-nota">Todo usuário pertence a uma empresa. Por isso o <b>administrador da empresa</b> é criado junto, no próximo passo.</div>
          <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button type="button" onClick={proximo}>Próximo</button></div>
        </div>
      ) : (
        <form className="form-stack" onSubmit={criar}>
          <div className="ped-nota" style={{ marginTop: 0 }}>
            <div className="ped-linha"><span>Empresa</span><b>{f.nome}</b></div>
            <div className="ped-linha"><span>Plano · primeira loja</span><b>{f.plano === 'basico' ? 'Básico' : 'Completo'} · {f.loja_nome || 'Loja única'}</b></div>
          </div>
          <label className="field"><span className="field-label">Nome do administrador</span><input autoFocus value={f.admin_nome} onChange={mudar('admin_nome')} /></label>
          <label className="field"><span className="field-label">E-mail (será o login)</span><input type="email" value={f.admin_email} onChange={mudar('admin_email')} placeholder="admin@empresa.com" /></label>
          <label className="field"><span className="field-label">Senha temporária</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={f.senha} onChange={mudar('senha')} />
              <button type="button" className="btn-link" onClick={() => setF({ ...f, senha: gerarSenha() })}>Gerar outra</button>
            </div>
          </label>
          <label className="cli-check"><input type="checkbox" checked disabled /> Exigir troca de senha no primeiro login</label>
          <div className="modal-actions">
            <button type="button" onClick={() => setPasso(1)} disabled={salvando}>Voltar</button>
            <button type="submit" disabled={salvando}>{salvando ? 'Criando...' : 'Criar empresa e administrador'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

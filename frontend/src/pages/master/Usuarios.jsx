import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast, useConfirm } from '../../context/UiContext.jsx';
import { quando } from './util.js';
import NovoUsuarioModal from './NovoUsuarioModal.jsx';
import SenhaUnicaModal from './SenhaUnicaModal.jsx';
import EmailUsuarioModal from './EmailUsuarioModal.jsx';

const SITUACOES = [['', 'Todas as situações'], ['ativos', 'Ativos'], ['inativos', 'Inativos'], ['falhas', '3+ falhas de login'], ['sem_login', 'Sem login há 30+ dias']];

export default function Usuarios() {
  const toast = useToast();
  const confirmar = useConfirm();
  const [dados, setDados] = useState(null);
  const [empresas, setEmpresas] = useState([]);
  const [empresaId, setEmpresaId] = useState('');
  const [busca, setBusca] = useState('');
  const [situacao, setSituacao] = useState('');
  const [novo, setNovo] = useState(false);
  const [verTeste, setVerTeste] = useState(false);
  const [editandoEmail, setEditandoEmail] = useState(null);
  const [novaSenha, setNovaSenha] = useState(null); // { usuario, senha } mostrada uma unica vez

  const carregar = useCallback(async () => {
    const qs = new URLSearchParams();
    if (empresaId) qs.set('empresa_id', empresaId);
    if (busca.trim()) qs.set('q', busca.trim());
    if (situacao) qs.set('situacao', situacao);
    if (verTeste) qs.set('teste', '1');
    try { setDados(await api.get(`/master/usuarios?${qs.toString()}`)); } catch (err) { toast.erro(err); }
  }, [empresaId, busca, situacao, verTeste, toast]);
  useEffect(() => { const t = setTimeout(carregar, 200); return () => clearTimeout(t); }, [carregar]);
  useEffect(() => { api.get(`/master/empresas${verTeste ? '?teste=1' : ''}`).then((r) => setEmpresas(r.empresas)).catch(() => {}); }, [verTeste]);

  async function acao(promessa, msg) {
    try { await promessa; toast.sucesso(msg); await carregar(); } catch (err) { toast.erro(err); }
  }
  async function encerrar(u) {
    if (!(await confirmar({ titulo: `Encerrar as sessões de ${u.nome}?`, mensagem: 'Ele precisará entrar de novo em todos os dispositivos.', confirmar: 'Encerrar sessões', perigo: true }))) return;
    acao(api.post(`/master/usuarios/${u.id}/encerrar-sessoes`), `Todas as sessões de ${u.nome} foram encerradas`);
  }
  async function resetar2fa(u) {
    if (!(await confirmar({ titulo: `Resetar o 2FA de ${u.nome}?`, mensagem: 'O segredo e os códigos de recuperação são apagados e as sessões atuais caem. Ele terá de configurar o app de novo.', confirmar: 'Resetar 2FA', perigo: true }))) return;
    acao(api.post(`/master/usuarios/${u.id}/2fa/resetar`), `2FA de ${u.nome} resetado`);
  }
  async function redefinirSenha(u) {
    if (!(await confirmar({ titulo: `Redefinir a senha de ${u.nome}?`, mensagem: 'Uma senha temporária será gerada e mostrada uma única vez. As sessões abertas dele caem e ele terá de trocar a senha ao entrar.', confirmar: 'Gerar nova senha', perigo: true }))) return;
    try {
      const r = await api.post(`/master/usuarios/${u.id}/redefinir-senha`);
      setNovaSenha({ usuario: u, senha: r.senha_temporaria });
      carregar();
    } catch (err) { toast.erro(err); }
  }
  async function alternarAtivo(u) {
    if (u.ativo && !(await confirmar({ titulo: `Desativar ${u.nome}?`, mensagem: 'O acesso é cortado na hora.', confirmar: 'Desativar', perigo: true }))) return;
    acao(api.patch(`/master/usuarios/${u.id}/status`, { ativo: !u.ativo }), `${u.nome} ${u.ativo ? 'desativado' : 'reativado'}`);
  }

  const r = dados && dados.resumo;
  return (
    <div>
      <div className="ped-head" style={{ marginTop: 6 }}>
        <h3 style={{ margin: 0 }}>Usuários & segurança</h3>
        <button type="button" className="btn-primario" onClick={() => setNovo(true)}>+ Novo usuário</button>
      </div>

      <div className="ped-kpis" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="ped-kpi"><small>Usuários ativos</small><b>{r ? r.ativos : '—'}</b><span className="cl-sub">de {r ? r.total : '—'} cadastrados</span></div>
        <div className="ped-kpi" style={r && r.usuarios_3_falhas > 0 ? { borderColor: 'var(--warn)' } : undefined}><small>Logins com falha (24 h)</small><b style={{ color: 'var(--warn)' }}>{r ? r.falhas_24h : '—'}</b><span className="cl-sub">{r ? r.usuarios_3_falhas : 0} usuário(s) com 3+ tentativas</span></div>
        <div className="ped-kpi"><small>Sem login há 30+ dias</small><b>{r ? r.sem_login_30d : '—'}</b><span className="cl-sub">candidatos a desativar</span></div>
      </div>

      <div className="card mt-master-card">
        <h4 style={{ margin: '0 0 8px' }}>Perfil Master</h4>
        <div className="cl-sub" style={{ margin: '0 0 6px' }}>Empresa <b>Plataforma</b> (sem lojas e sem dados) · criado só por script (<code>npm run master</code>) · não aparece na tela de usuários das empresas e não pode ser editado nem desativado por elas.</div>
        <div className="cl-sub" style={{ margin: 0 }}>O Master não opera dados de empresas em produção. Em modo teste ele escolhe uma empresa e atua como Administrador dela, só no banco de teste.</div>
      </div>

      <div className="ped-bar">
        <select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)} aria-label="Empresa" style={{ width: 'auto' }}>
          <option value="">Todas as empresas</option>
          {empresas.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
        </select>
        <select value={situacao} onChange={(e) => setSituacao(e.target.value)} aria-label="Situação" style={{ width: 'auto' }}>
          {SITUACOES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <label className="check-linha" title="Empresas e usuários criados pelos testes automatizados (E2E) ficam ocultos por padrão"><input type="checkbox" checked={verTeste} onChange={(e) => setVerTeste(e.target.checked)} /> Mostrar dados de teste (E2E)</label>
        <input className="ped-busca" style={{ maxWidth: 300 }} value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nome ou e-mail" aria-label="Buscar usuário" />
      </div>

      <div className="card">
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Usuário</th><th>Empresa</th><th>Perfil</th><th>Último login</th><th>Falhas</th><th>Modo teste</th><th>2FA</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {dados && dados.usuarios.map((u) => (
                <tr key={u.id}>
                  <td><b>{u.nome}</b><div className="cl-sub">{u.email}</div></td>
                  <td>{u.empresa_nome}</td>
                  <td><span className="ped-tag">{u.perfil}</span></td>
                  <td>{quando(u.ultimo_login)}</td>
                  <td>{u.falhas_login >= 3 ? <span className="ped-pill warn">{u.falhas_login}</span> : u.falhas_login}</td>
                  <td>
                    <div className="cl-sw">
                      <button type="button" role="switch" aria-checked={u.modo_teste} className={u.modo_teste ? 'on' : ''}
                        onClick={() => acao(api.patch(`/master/usuarios/${u.id}/permissoes`, { ModoTeste: !u.modo_teste }), `Modo teste ${u.modo_teste ? 'retirado de' : 'liberado para'} ${u.nome}`)} />
                      <span className="cl-sub" style={{ margin: 0 }}>{u.modo_teste ? 'liberado' : '—'}</span>
                    </div>
                  </td>
                  <td>{u.totp_ativo ? <span className="ped-pill ok">Ativo</span> : <span className="cl-sub" style={{ margin: 0 }}>Não ativo</span>}{(u.totp_exigido || u.perfil === 'Master') && <span className="ped-tag" style={{ marginLeft: 6 }}>exigido</span>}</td>
                  <td><span className={`ped-pill ${u.ativo ? 'ok' : 'err'}`}>{u.ativo ? 'Ativo' : 'Inativo'}</span></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {u.perfil !== 'Master' && <button type="button" className="btn-link" onClick={() => setEditandoEmail(u)}>Alterar e-mail</button>}{' '}
                    {u.perfil !== 'Master' && <button type="button" className="btn-link" onClick={() => redefinirSenha(u)}>Redefinir senha</button>}{' '}
                    <button type="button" className="btn-link" onClick={() => acao(api.post(`/master/usuarios/${u.id}/forcar-troca-senha`), `Troca de senha exigida no próximo login de ${u.nome}`)}>Forçar troca de senha</button>{' '}
                    <button type="button" className="btn-link" onClick={() => encerrar(u)}>Encerrar sessões</button>{' '}
                    {u.perfil !== 'Master' && <button type="button" className="btn-link" onClick={() => acao(api.patch(`/master/usuarios/${u.id}/exigir-2fa`, { exigido: !u.totp_exigido }), u.totp_exigido ? `2FA deixou de ser exigido de ${u.nome}` : `2FA exigido de ${u.nome} no próximo login`)}>{u.totp_exigido ? 'Dispensar 2FA' : 'Exigir 2FA'}</button>}{' '}
                    {u.totp_ativo && u.perfil !== 'Master' && <button type="button" className="btn-link" onClick={() => resetar2fa(u)}>Resetar 2FA</button>}{' '}
                    <button type="button" className={`btn-link ${u.ativo ? 'perigo' : ''}`} onClick={() => alternarAtivo(u)}>{u.ativo ? 'Desativar' : 'Reativar'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {dados && dados.usuarios.length === 0 && <div className="ped-vazio">Nenhum usuário neste filtro</div>}
      </div>

      {novaSenha && <SenhaUnicaModal titulo="Senha redefinida" resumo={`${novaSenha.usuario.nome} (${novaSenha.usuario.email}) · informe esta senha ao usuário; ele troca no próximo login.`} senha={novaSenha.senha} onClose={() => setNovaSenha(null)} />}
      {editandoEmail && <EmailUsuarioModal usuario={editandoEmail} onClose={() => setEditandoEmail(null)} onSalvo={() => { setEditandoEmail(null); carregar(); }} />}
      {novo && <NovoUsuarioModal onClose={() => setNovo(false)} onCriado={() => { setNovo(false); carregar(); }} />}
    </div>
  );
}

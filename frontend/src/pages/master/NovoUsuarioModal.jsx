import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Modal } from '../../components/ui.jsx';
import { gerarSenha, NOME_PERFIL } from './util.js';
import SenhaUnicaModal from './SenhaUnicaModal.jsx';

// Novo usuario SEMPRE dentro de uma empresa: a empresa e obrigatoria (fixa quando aberto pela ficha da empresa).
export default function NovoUsuarioModal({ empresaFixa, onClose, onCriado }) {
  const toast = useToast();
  const [empresas, setEmpresas] = useState([]);
  const [empresaId, setEmpresaId] = useState(empresaFixa || '');
  const [ficha, setFicha] = useState(null);
  const [f, setF] = useState({ nome: '', email: '', perfil: 'Caixa/Operador', lojas: [], senha: gerarSenha() });
  const [salvando, setSalvando] = useState(false);
  const [criado, setCriado] = useState(null);

  useEffect(() => {
    if (empresaFixa) return;
    api.get('/master/empresas').then((r) => setEmpresas(r.empresas.filter((e) => e.status === 'ativa'))).catch((err) => toast.erro(err));
  }, [empresaFixa, toast]);
  useEffect(() => {
    setFicha(null);
    setF((x) => ({ ...x, lojas: [] }));
    if (!empresaId) return;
    api.get(`/master/empresas/${empresaId}`).then(setFicha).catch((err) => toast.erro(err));
  }, [empresaId, toast]);

  const limUsuarios = ficha && ficha.limites.find((l) => l.chave === 'usuarios');
  const noLimite = !!limUsuarios && limUsuarios.usado >= limUsuarios.limite;
  const lojasAtivas = ficha ? ficha.lojas.filter((l) => l.ativo) : [];
  const admin = f.perfil === 'Administrador';

  function alternarLoja(id) {
    setF((x) => ({ ...x, lojas: x.lojas.includes(id) ? x.lojas.filter((l) => l !== id) : [...x.lojas, id] }));
  }

  async function salvar(e) {
    e.preventDefault();
    if (!empresaId) { toast.erro('Escolha a empresa do usuário'); return; }
    if (f.nome.trim().length < 2) { toast.erro('Informe o nome'); return; }
    if (!/^\S+@\S+\.\S+$/.test(f.email)) { toast.erro('Informe um e-mail válido'); return; }
    if (!admin && f.lojas.length === 0) { toast.erro('Escolha ao menos uma loja'); return; }
    setSalvando(true);
    try {
      const resp = await api.post('/master/usuarios', {
        empresa_id: empresaId, nome: f.nome, email: f.email, perfil: f.perfil, senha: f.senha,
        location_id: admin ? null : f.lojas[0], location_ids: admin ? [] : f.lojas.slice(1),
      });
      setCriado(resp);
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  if (criado) {
    return <SenhaUnicaModal titulo="Usuário criado" resumo={`${criado.usuario.nome} (${criado.usuario.email}) · ${criado.usuario.perfil}`} senha={criado.senha_temporaria} onClose={onCriado} />;
  }

  return (
    <Modal titulo="Novo usuário" subtitulo="Todo usuário pertence a uma empresa" onClose={salvando ? undefined : onClose} largura="larga">
      <form className="form-stack" onSubmit={salvar}>
        <label className="field"><span className="field-label">Empresa *</span>
          {empresaFixa
            ? <input value={ficha ? ficha.nome : '...'} disabled />
            : (
              <select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)} autoFocus>
                <option value="">Escolha a empresa...</option>
                {empresas.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
              </select>
            )}
        </label>
        {limUsuarios && (
          <div className={`ped-nota ${noLimite ? 'mt-limite' : ''}`} style={{ marginTop: 0 }}>
            <b>{limUsuarios.usado} de {limUsuarios.limite}</b> usuários usados neste plano{noLimite && ' — limite atingido: ajuste o plano da empresa para criar mais usuários.'}
          </div>
        )}
        <div className="form-grid">
          <label className="field"><span className="field-label">Nome</span><input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} /></label>
          <label className="field"><span className="field-label">E-mail (login)</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        </div>
        <label className="field"><span className="field-label">Perfil</span>
          <select value={f.perfil} onChange={(e) => setF({ ...f, perfil: e.target.value })}>{NOME_PERFIL.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        </label>
        <div className="field"><span className="field-label">Lojas</span>
          {admin ? <div className="cl-sub">Administrador vê todas as lojas da empresa.</div> : (
            !empresaId ? <div className="cl-sub">Escolha a empresa para listar as lojas.</div> : (
              <div className="cli-chips">
                {lojasAtivas.map((l) => <button type="button" key={l.id} className={f.lojas.includes(l.id) ? 'on' : ''} onClick={() => alternarLoja(l.id)}>🏪 {l.nome}{f.lojas[0] === l.id ? ' (principal)' : ''}</button>)}
                {lojasAtivas.length === 0 && <span className="cl-sub">Esta empresa ainda não tem lojas ativas.</span>}
              </div>
            )
          )}
        </div>
        <label className="field"><span className="field-label">Senha temporária</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={f.senha} onChange={(e) => setF({ ...f, senha: e.target.value })} />
            <button type="button" className="btn-link" onClick={() => setF({ ...f, senha: gerarSenha() })}>Gerar outra</button>
          </div>
        </label>
        <label className="cli-check"><input type="checkbox" checked disabled /> Exigir troca de senha no primeiro login</label>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={salvando}>Cancelar</button>
          <button type="submit" disabled={salvando || noLimite || !empresaId}>{salvando ? 'Criando...' : 'Criar usuário'}</button>
        </div>
      </form>
    </Modal>
  );
}

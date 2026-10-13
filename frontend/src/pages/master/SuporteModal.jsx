import { useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';

// "Entrar como suporte": motivo obrigatorio, codigo do 2FA, avisar administradores (ligado) e permitir edicao (desligado).
export default function SuporteModal({ empresa, onClose }) {
  const { entrarSuporte } = useAuth();
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [codigo, setCodigo] = useState('');
  const [avisar, setAvisar] = useState(true);
  const [edicao, setEdicao] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState(null);

  async function enviar(e) {
    e.preventDefault();
    setErro(null); setEnviando(true);
    try {
      await entrarSuporte({ empresaId: empresa.id, motivo: motivo.trim(), codigo: codigo.trim(), avisar, edicao });
      window.location.assign('/');
    } catch (err) { setErro(err.message); setCodigo(''); setEnviando(false); toast.erro(err); }
  }

  return (
    <Modal titulo="Entrar como suporte" subtitulo={empresa.nome} onClose={enviando ? undefined : onClose}>
      <form onSubmit={enviar} className="form-stack">
        <p className="cl-sub" style={{ margin: 0 }}>Sessão de <b>30 minutos</b>, sem renovação, como Administrador da empresa. É <b>somente leitura</b> a menos que você libere a edição, e tudo fica registrado na auditoria.</p>
        <Field label="Motivo do acesso *" hint={`${motivo.trim().length}/300 · mínimo de 10 caracteres. Aparece para os administradores da empresa.`}>
          <textarea rows={3} maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus required />
        </Field>
        <div className="cl-sw">
          <button type="button" role="switch" aria-checked={avisar} aria-label="Avisar administradores" className={avisar ? 'on' : ''} onClick={() => setAvisar(!avisar)} />
          <span>Avisar o administrador da empresa<div className="cl-sub">Mostra um aviso dentro do sistema, sem o seu nome.</div></span>
        </div>
        <div className="cl-sw">
          <button type="button" role="switch" aria-checked={edicao} aria-label="Permitir edição" className={edicao ? 'on' : ''} onClick={() => setEdicao(!edicao)} />
          <span>Permitir edição durante o suporte<div className="cl-sub">Só cadastros (produtos, fornecedores, lojas, PDVs, estoque). Usuários, senhas, 2FA, cancelamentos e exclusões ficam sempre bloqueados.</div></span>
        </div>
        <Field label="Código do app autenticador *" hint="Confirmação do seu 2FA (6 dígitos).">
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} required />
        </Field>
        {erro && <p className="error" role="alert">{erro}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={enviando}>Cancelar</button>
          <button type="submit" disabled={enviando || motivo.trim().length < 10 || codigo.length !== 6}>{enviando ? 'Entrando…' : 'Entrar'}</button>
        </div>
      </form>
    </Modal>
  );
}

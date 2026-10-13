import { useToast } from '../../context/UiContext.jsx';
import { Modal } from '../../components/ui.jsx';
import { copiar } from './util.js';

// Senha temporaria: aparece UMA vez, com botao copiar.
export default function SenhaUnicaModal({ titulo, resumo, senha, onClose }) {
  const toast = useToast();
  return (
    <Modal titulo={titulo} onClose={onClose}>
      <div className="form-stack">
        <p className="muted">{resumo}</p>
        <div className="ped-nota" style={{ borderColor: 'var(--warn)' }}>
          <b>Senha temporária (aparece só agora):</b>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <code style={{ fontSize: 18, fontWeight: 800, letterSpacing: 1 }}>{senha}</code>
            <button type="button" className="btn-link" onClick={async () => toast.sucesso((await copiar(senha)) ? 'Senha copiada' : 'Não foi possível copiar: anote a senha')}>Copiar</button>
          </div>
          <div className="cl-sub">A senha não é guardada em lugar nenhum. O usuário será obrigado a trocá-la no primeiro login.</div>
        </div>
        <div className="modal-actions"><button type="button" onClick={onClose}>Entendi, já anotei</button></div>
      </div>
    </Modal>
  );
}

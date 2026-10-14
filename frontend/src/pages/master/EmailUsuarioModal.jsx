import { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';

// Master altera o e-mail de acesso de um usuario de empresa (as sessoes abertas dele caem).
export default function EmailUsuarioModal({ usuario, onClose, onSalvo }) {
  const toast = useToast();
  const [email, setEmail] = useState(usuario.email);
  const [salvando, setSalvando] = useState(false);

  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      await api.patch(`/master/usuarios/${usuario.id}/email`, { email });
      toast.sucesso(`E-mail de ${usuario.nome} alterado`);
      onSalvo();
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  return (
    <Modal titulo="Alterar e-mail de acesso" subtitulo={`${usuario.nome} · ${usuario.empresa_nome}`} onClose={onClose}>
      <form onSubmit={salvar} className="form-stack">
        <Field label="E-mail de acesso" hint="Precisa ser único no sistema. As sessões abertas do usuário caem."><input type="email" maxLength={120} value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar e-mail'}</button>
        </div>
      </form>
    </Modal>
  );
}

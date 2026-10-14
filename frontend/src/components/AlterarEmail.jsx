import { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/UiContext.jsx';
import { Field, Modal } from './ui.jsx';

// "Alterar meu e-mail de acesso" (menu da conta): exige a senha atual. O e-mail e o que a pessoa digita para entrar.
export default function AlterarEmail({ onClose }) {
  const { user, recarregarUsuario } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ novo_email: '', senha_atual: '' });
  const [salvando, setSalvando] = useState(false);

  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      await api.post('/auth/alterar-email', form);
      await recarregarUsuario();
      toast.sucesso('E-mail de acesso alterado. Use o novo e-mail no próximo login.');
      onClose();
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  return (
    <Modal titulo="Alterar meu e-mail de acesso" onClose={onClose}>
      <form onSubmit={salvar} className="form-stack">
        <p className="cl-sub" style={{ margin: 0 }}>E-mail atual: <b>{user?.email}</b></p>
        <Field label="Novo e-mail"><input type="email" autoComplete="email" maxLength={120} value={form.novo_email} onChange={(e) => setForm({ ...form, novo_email: e.target.value })} required /></Field>
        <Field label="Senha atual" hint="Para confirmar que é você"><input type="password" autoComplete="current-password" value={form.senha_atual} onChange={(e) => setForm({ ...form, senha_atual: e.target.value })} required /></Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar e-mail'}</button>
        </div>
      </form>
    </Modal>
  );
}

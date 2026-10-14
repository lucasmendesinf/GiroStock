import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Field, Modal } from './ui.jsx';

// "Dados da empresa" (menu da conta): e-mail, telefone e responsavel. So informativos; quem tem a area Configuracoes edita.
export default function DadosEmpresa({ onClose, podeEditar }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => { api.get('/empresa').then(setD).catch((e) => { toast.erro(e); onClose(); }); }, [toast, onClose]);

  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      setD(await api.put('/empresa', { email_contato: d.email_contato || '', telefone: d.telefone || '', responsavel: d.responsavel || '' }));
      toast.sucesso('Dados da empresa salvos.');
      onClose();
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  const campo = (k, v) => setD({ ...d, [k]: v });
  return (
    <Modal titulo="Dados da empresa" subtitulo={d ? d.nome : undefined} onClose={onClose}>
      {!d ? <p className="muted">Carregando…</p> : (
        <form onSubmit={salvar} className="form-stack">
          {d.documento && <p className="cl-sub" style={{ margin: 0 }}>CNPJ/CPF: {d.documento}</p>}
          <Field label="Responsável" hint="Quem responde pela empresa"><input value={d.responsavel || ''} maxLength={100} disabled={!podeEditar} onChange={(e) => campo('responsavel', e.target.value)} /></Field>
          <Field label="E-mail de contato"><input type="email" value={d.email_contato || ''} maxLength={120} disabled={!podeEditar} onChange={(e) => campo('email_contato', e.target.value)} /></Field>
          <Field label="Telefone" hint="Com DDD"><input type="tel" value={d.telefone || ''} maxLength={30} disabled={!podeEditar} onChange={(e) => campo('telefone', e.target.value)} /></Field>
          {!podeEditar && <p className="cl-sub">Só quem administra a empresa pode alterar estes dados.</p>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>{podeEditar ? 'Cancelar' : 'Fechar'}</button>
            {podeEditar && <button type="submit" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</button>}
          </div>
        </form>
      )}
    </Modal>
  );
}

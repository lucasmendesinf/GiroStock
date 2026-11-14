import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Field, Modal } from './ui.jsx';
import { parseNumero } from '../utils/format';

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
      const margem = parseNumero(String(d.combo_margem_pct ?? '').replace('.', ',') || '0');
      setD(await api.put('/empresa', { email_contato: d.email_contato || '', telefone: d.telefone || '', responsavel: d.responsavel || '', combo_margem_pct: margem, combo_preco_final_90: !!d.combo_preco_final_90 }));
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
          <div className="es-titulo" style={{ marginTop: 6, marginBottom: 0 }}>Combos</div>
          <Field label="Margem padrão dos combos (%)" hint="Vale para os combos novos; você pode mudar a margem em cada combo ao cadastrá-lo. Margem sobre o preço de venda (0 a menos de 95).">
            <input inputMode="decimal" value={String(d.combo_margem_pct ?? '').replace('.', ',')} disabled={!podeEditar} onChange={(e) => campo('combo_margem_pct', e.target.value)} />
          </Field>
          <label className="check"><input type="checkbox" checked={d.combo_preco_final_90 !== false} disabled={!podeEditar} onChange={(e) => campo('combo_preco_final_90', e.target.checked)} /> Terminar o preço sugerido em ,90</label>
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

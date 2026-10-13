import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/UiContext.jsx';
import { Modal } from './ui.jsx';

// Ligar o modo teste da sessao. Usuario comum: confirma e entra no banco de teste (mesma empresa e lojas).
// Master: escolhe a empresa a testar. Na primeira vez o servidor pede a copia da producao (passo "copiar").
export default function ModoTesteModal({ empresas = [], onClose }) {
  const { user, alternarModoTeste } = useAuth();
  const toast = useToast();
  const master = !!(user && user.master);
  const [empresaId, setEmpresaId] = useState(empresas[0] ? empresas[0].id : '');
  const [passo, setPasso] = useState('confirmar'); // confirmar | copiar
  const [anonimizar, setAnonimizar] = useState(true);
  const [trabalhando, setTrabalhando] = useState(false);

  async function ligar(copiar) {
    if (master && !empresaId) { toast.erro('Escolha a empresa a testar.'); return; }
    setTrabalhando(true);
    try {
      await alternarModoTeste(true, { empresa_id: master ? empresaId : undefined, confirmar_copia: copiar || undefined, anonimizar });
      window.location.assign('/');
    } catch (err) {
      if (err.dados && err.dados.precisa_copia) setPasso('copiar');
      else toast.erro(err);
      setTrabalhando(false);
    }
  }

  return (
    <Modal titulo="Modo teste" subtitulo="Trabalhe em um banco de teste, separado da produção" onClose={trabalhando ? undefined : onClose}>
      {passo === 'confirmar' ? (
        <div className="form-stack">
          <p className="muted">
            Ao ligar, <b>esta sessão</b> passa a usar apenas o banco de teste: nada do que você fizer aparece na produção, e as outras sessões continuam na produção.
            Para voltar, use o botão da faixa amarela no topo.
          </p>
          {master && (
            <label className="field"><span className="field-label">Testar como empresa</span>
              <select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)}>
                {empresas.length === 0 && <option value="">Nenhuma empresa no banco de teste (copie a produção primeiro)</option>}
                {empresas.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
              </select>
              <span className="field-hint">Você entra como Administrador dessa empresa, só no banco de teste.</span>
            </label>
          )}
          <div className="modal-actions">
            <button type="button" onClick={onClose} disabled={trabalhando}>Cancelar</button>
            <button type="button" disabled={trabalhando || (master && !empresaId)} onClick={() => ligar(false)}>{trabalhando ? 'Verificando...' : 'Ligar modo teste'}</button>
          </div>
        </div>
      ) : (
        <div className="form-stack">
          <div className="ped-nota"><b>Primeira vez:</b> o banco de teste ainda está vazio. Vamos copiar <b>tudo da produção</b> para ele (a produção não é alterada).</div>
          <label className="cli-check"><input type="checkbox" checked={anonimizar} onChange={(e) => setAnonimizar(e.target.checked)} /> Anonimizar nomes e telefones de clientes ao copiar (recomendado)</label>
          <div className="modal-actions">
            <button type="button" onClick={onClose} disabled={trabalhando}>Cancelar</button>
            <button type="button" disabled={trabalhando} onClick={() => ligar(true)}>{trabalhando ? 'Copiando...' : 'Copiar e ligar o modo teste'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

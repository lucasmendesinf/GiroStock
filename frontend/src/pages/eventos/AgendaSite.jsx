import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';
import { Modal } from '../../components/ui.jsx';

// Agenda no site: os eventos marcados "Divulgar no site" aparecem no site da casa. Basta colar o codigo (widget) no site;
// para sites com integracao propria (ex.: PHP), ha o endereco da API. A chave e publica (vai no site) e pode ser trocada.
export default function AgendaSite({ onClose }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [a, setA] = useState(null);
  useEffect(() => { api.get('/eventos-agenda').then(setA).catch((err) => { toast.erro(err); onClose(); }); }, [toast, onClose]);
  if (!a) return <Modal titulo="Agenda no site" onClose={onClose}><p className="muted">Carregando…</p></Modal>;

  async function copiar(t, msg) {
    try { await navigator.clipboard.writeText(t); toast.sucesso(msg); } catch { toast.erro('Não foi possível copiar: selecione e copie manualmente'); }
  }
  async function alternar() {
    try { setA(await api.put('/eventos-agenda', { ativa: !a.ativa })); toast.sucesso(a.ativa ? 'Agenda tirada do site' : 'Agenda ligada no site'); } catch (err) { toast.erro(err); }
  }
  async function novaChave() {
    if (!(await confirmar({ titulo: 'Gerar uma chave nova?', mensagem: 'O código que está no site para de funcionar até você colar o código novo.', confirmar: 'Gerar chave nova', perigo: true }))) return;
    try { setA(await api.post('/eventos-agenda/chave')); toast.sucesso('Chave nova gerada: atualize o código no site'); } catch (err) { toast.erro(err); }
  }

  return (
    <Modal titulo="Agenda no site" subtitulo="Os eventos marcados “Divulgar no site” aparecem no site da casa e somem sozinhos depois que acontecem." onClose={onClose} largura="larga">
      <div className="form-stack">
        <div className="ev-agenda-status">
          <span className={`ped-pill ${a.ativa ? 'ok' : ''}`}>{a.ativa ? 'Ligada' : 'Desligada'}</span>
          <span className="cl-sub">{a.eventos_no_site} evento(s) aparecendo no site agora</span>
          <span className="toolbar-espaco" />
          <button type="button" className="btn-link" onClick={alternar}>{a.ativa ? 'Tirar do site' : 'Ligar no site'}</button>
        </div>
        <div>
          <b>1. Código para colar no site</b>
          <p className="cl-sub" style={{ margin: '4px 0 8px' }}>Cole onde a agenda deve aparecer (funciona em qualquer site: HTML, PHP, WordPress, Wix…).</p>
          <pre className="ev-codigo">{a.codigo}</pre>
          <button type="button" className="btn-primario" onClick={() => copiar(a.codigo, 'Código copiado')}>Copiar código</button>
        </div>
        <details className="lv-avancado">
          <summary>Para quem faz o site (integração própria)</summary>
          <p className="cl-sub">A agenda em JSON, para montar com o visual do site (ex.: em PHP no servidor do site):</p>
          <pre className="ev-codigo">{a.url_api}</pre>
          <button type="button" className="btn-link" onClick={() => copiar(a.url_api, 'Endereço copiado')}>Copiar endereço</button>
          <p className="cl-sub">Opções do código: <code>data-limite="6"</code>, <code>data-tema="escuro"</code> ou <code>"claro"</code>, <code>data-cor="#f0b429"</code>, <code>data-estilo="nenhum"</code> (sem o visual pronto).</p>
          <p className="cl-sub">Chave da agenda: <code>{a.chave}</code> · <button type="button" className="btn-link perigo" onClick={novaChave}>gerar chave nova</button></p>
        </details>
      </div>
    </Modal>
  );
}

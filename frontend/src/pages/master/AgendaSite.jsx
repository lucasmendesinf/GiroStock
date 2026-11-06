import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';

// Agenda de eventos no site do cliente (site feito e hospedado pela Calutec): chave publica e endereco que o site usa para
// buscar os eventos marcados "Divulgar no site" e o pop-up do dia. O cliente nao ve isto: so cadastra os eventos.
export default function AgendaSite({ empresaId }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [d, setD] = useState(null);
  const carregar = useCallback(() => api.get(`/master/empresas/${empresaId}/agenda-site`).then(setD).catch((err) => toast.erro(err)), [empresaId, toast]);
  useEffect(() => { carregar(); }, [carregar]);
  if (!d) return null;

  async function copiar(t) {
    try { await navigator.clipboard.writeText(t); toast.sucesso('Copiado'); } catch { toast.erro('Não foi possível copiar: selecione e copie manualmente'); }
  }
  async function alternar() {
    try { setD(await api.put(`/master/empresas/${empresaId}/agenda-site`, { ativa: !d.ativa })); } catch (err) { toast.erro(err); }
  }
  async function novaChave() {
    if (!(await confirmar({ titulo: 'Gerar uma chave nova?', mensagem: 'O site da empresa para de mostrar os eventos até receber a chave nova.', confirmar: 'Gerar chave nova', perigo: true }))) return;
    try { setD(await api.post(`/master/empresas/${empresaId}/agenda-site/chave`)); toast.sucesso('Chave nova gerada: atualize o site'); } catch (err) { toast.erro(err); }
  }
  return (
    <div className="ped-sec">
      <span className="ped-rotulo">Eventos · agenda no site da empresa</span>
      {!d.modulo_ligado && <div className="cl-sub">O módulo Casa de shows e eventos está desligado para esta empresa: a agenda só aparece no site quando ele for liberado.</div>}
      <div className="form-stack" style={{ marginTop: 6, gap: 6 }}>
        <div className="cl-sub">{d.ativa ? 'Ligada' : 'Desligada'} · {d.eventos_no_site} evento(s) no site agora · <button type="button" className="btn-link" onClick={alternar}>{d.ativa ? 'desligar' : 'ligar'}</button></div>
        <div><span className="cl-sub">Chave (vai no site):</span> <code className="lv-codigo">{d.chave}</code> <button type="button" className="btn-link" onClick={() => copiar(d.chave)}>copiar</button></div>
        <div><span className="cl-sub">Endereço da agenda (JSON):</span> <code className="lv-codigo">{d.url_api}</code> <button type="button" className="btn-link" onClick={() => copiar(d.url_api)}>copiar</button></div>
        <div className="cl-sub">No site em PHP, use <code>docs/agenda-site/proximos-eventos.php</code> com esta chave (lista e pop-up do banner). <button type="button" className="btn-link perigo" onClick={novaChave}>gerar chave nova</button></div>
      </div>
    </div>
  );
}

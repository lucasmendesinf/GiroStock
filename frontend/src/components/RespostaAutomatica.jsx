import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Field } from './ui.jsx';

// Resposta automatica do WhatsApp: quando o cliente manda mensagem, recebe o link do cardapio (1 vez a cada X horas).
// A equipe continua respondendo normalmente pelo WhatsApp Business do celular.
export default function RespostaAutomatica() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [salvando, setSalvando] = useState(false);
  useEffect(() => {
    api.get('/whatsapp/resposta').then((r) => { setD(r); if (r) setF({ texto: r.texto, link: r.link_digitado || '', intervalo_horas: String(r.intervalo_horas) }); }).catch((err) => toast.erro(err));
  }, [toast]);
  if (!d || !f) return null;
  async function salvar(extra = {}) {
    setSalvando(true);
    try {
      const r = await api.put('/whatsapp/resposta', { texto: f.texto, link: f.link, intervalo_horas: Number(f.intervalo_horas), ...extra });
      setD(r);
      toast.sucesso(extra.ativo === true ? 'Resposta automática ligada' : extra.ativo === false ? 'Resposta automática desligada' : 'Resposta automática salva');
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const linkUsado = f.link.trim() || d.link;
  const exemplo = String(f.texto || '').replace(/\{loja\}/g, 'sua loja').replace(/\{link\}/g, linkUsado || '(endereço do cardápio)');
  return (
    <div className="card">
      <div className="toolbar" style={{ marginTop: 0 }}>
        <h3 style={{ margin: 0, flex: 1 }}>Resposta automática com o cardápio</h3>
        <label className="check"><input type="checkbox" checked={d.ativo} disabled={salvando} onChange={(e) => salvar({ ativo: e.target.checked })} /> Ligada</label>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Quando o cliente manda mensagem no WhatsApp, recebe na hora o link do cardápio digital para fazer o pedido. No máximo uma vez a cada {f.intervalo_horas || 12} h por cliente; a sua equipe continua respondendo normalmente no celular. É uma resposta dentro da conversa aberta pelo cliente (a Meta não cobra como campanha).</p>
      <div className="wa-previa">
        <div className="form-stack">
          <Field label="Mensagem" hint="Use {link} onde entra o endereço do cardápio e {loja} para o nome da loja.">
            <textarea rows={4} value={f.texto} onChange={set('texto')} maxLength={1000} />
          </Field>
          <div className="form-grid">
            <Field label="Endereço do cardápio" hint={d.link && !d.link_digitado ? `Da loja virtual: ${d.link}` : 'Deixe em branco para usar o da loja virtual'}>
              <input value={f.link} onChange={set('link')} placeholder={d.link || 'https://minhaloja.com.br'} />
            </Field>
            <Field label="Responder de novo depois de (horas)"><input value={f.intervalo_horas} onChange={set('intervalo_horas')} inputMode="numeric" /></Field>
          </div>
          <div><button type="button" disabled={salvando} onClick={() => salvar()}>Salvar mensagem</button></div>
        </div>
        <div>
          <span className="field-label">Como o cliente recebe</span>
          <div className="wa-balao wa-balao-grande" style={{ whiteSpace: 'pre-wrap' }}>{exemplo}</div>
        </div>
      </div>
    </div>
  );
}

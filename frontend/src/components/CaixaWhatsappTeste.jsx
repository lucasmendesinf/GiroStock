import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Field, Vazio } from './ui.jsx';
import { dataHora } from '../utils/format';

// Modo teste: WhatsApp simulado. As mensagens NAO saem: aparecem aqui como o cliente veria. Da para simular o cliente
// respondendo (ex.: SAIR tira o consentimento de receber ofertas).
const fmtTel = (t) => { const d = String(t || '').replace(/^55/, ''); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : t; };

export default function CaixaWhatsappTeste() {
  const toast = useToast();
  const [lista, setLista] = useState(null);
  const [tel, setTel] = useState('');
  const [texto, setTexto] = useState('SAIR');
  const carregar = useCallback(() => api.get('/whatsapp/teste/caixa').then(setLista).catch(() => setLista([])), []);
  useEffect(() => { carregar(); const t = setInterval(carregar, 5000); return () => clearInterval(t); }, [carregar]);
  async function responder(e) {
    e.preventDefault();
    try {
      const r = await api.post('/whatsapp/teste/responder', { telefone: tel, texto });
      toast.sucesso(r.sair ? (r.clientes_descadastrados ? 'Cliente respondeu SAIR: não recebe mais ofertas' : 'SAIR recebido, mas nenhum cliente com este celular') : 'Resposta recebida (sem ação: só SAIR muda algo)');
      setTimeout(carregar, 500);
    } catch (err) { toast.erro(err); }
  }
  return (
    <div className="card wa-caixa-teste">
      <div className="toolbar" style={{ marginTop: 0 }}>
        <h3 style={{ margin: 0, flex: 1 }}>🧪 Mensagens que teriam sido enviadas (teste)</h3>
        <button type="button" className="btn-link" onClick={carregar}>Atualizar</button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Modo teste: o WhatsApp é simulado. Nada sai para o cliente; cada mensagem aparece aqui como ele veria. A lista é zerada quando o servidor reinicia.</p>
      {lista === null ? <p className="muted">Carregando…</p> : lista.length === 0 ? <Vazio>Nenhuma mensagem ainda. Crie um pedido com o celular do cliente ou envie uma campanha.</Vazio> : (
        <div className="wa-caixa-lista">
          {lista.map((m) => (
            <div key={m.wamid} className="wa-caixa-msg">
              <div className="celula-sub">Para <b>{fmtTel(m.para)}</b> · {dataHora(m.em)} · {m.categoria === 'MARKETING' ? 'campanha (marketing)' : m.categoria === 'TEXTO' ? 'resposta automática' : 'aviso do pedido'}</div>
              <div className="wa-balao wa-balao-grande">{m.texto || `(modelo ${m.modelo})`}{m.rodape && <small>{m.rodape}</small>}</div>
            </div>
          ))}
        </div>
      )}
      <form className="form-grid" onSubmit={responder} style={{ marginTop: 12 }}>
        <Field label="Simular resposta do cliente: celular"><input value={tel} onChange={(e) => setTel(e.target.value)} placeholder="(41) 99999-9999" inputMode="tel" required /></Field>
        <Field label="Mensagem"><input value={texto} onChange={(e) => setTexto(e.target.value)} /></Field>
        <button type="submit">Simular resposta</button>
      </form>
    </div>
  );
}

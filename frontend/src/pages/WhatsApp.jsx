import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useConfirm, useToast } from '../context/UiContext.jsx';
import { Field, Vazio } from '../components/ui.jsx';
import { dataHora } from '../utils/format';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import CampanhasWhatsApp from '../components/CampanhasWhatsApp.jsx';
import CaixaWhatsappTeste from '../components/CaixaWhatsappTeste.jsx';

// WhatsApp (API oficial da Meta): conectar o numero da empresa (cadastro incorporado da Meta; com a coexistencia o numero
// continua no WhatsApp Business do celular), escolher os avisos do pedido, testar e ver o historico das mensagens.
const SITUACAO = { enviada: ['Enviada', ''], entregue: ['Entregue', 'ok'], lida: ['Lida', 'ok'], falhou: ['Falhou', 'err'] };
const EVENTO = { campanha: 'Campanha', saiu: 'Cliente pediu para sair', recebido: 'Pedido recebido', em_preparo: 'Em preparo', pronto_retirada: 'Pronto para retirar', saiu_entrega: 'Saiu para entrega', entregue: 'Entregue', cancelado: 'Cancelado', teste: 'Teste' };
const MODELO = { APPROVED: ['Aprovado', 'ok'], PENDING: ['Em análise na Meta', 'warn'], REJECTED: ['Recusado pela Meta', 'err'], NAO_CRIADO: ['Não criado', 'err'] };

// SDK do Facebook (so quando a pessoa clica em Conectar).
function carregarSdk(appId, versao) {
  return new Promise((ok, falha) => {
    if (window.FB) { ok(window.FB); return; }
    window.fbAsyncInit = () => { window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: versao }); ok(window.FB); };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/pt_BR/sdk.js';
    s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
    s.onerror = () => falha(new Error('não foi possível carregar o Facebook (verifique a internet ou bloqueadores de anúncio)'));
    document.body.appendChild(s);
  });
}

export default function WhatsApp() {
  const toast = useToast();
  const confirmar = useConfirm();
  const [dados, setDados] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [conectando, setConectando] = useState(false);
  const [tel, setTel] = useState('');
  const [enviando, setEnviando] = useState(false);
  const sessao = useRef({});
  const { user } = useAuth();
  const { state } = useLocation();
  const podeCampanha = !!(user && user.areas && user.areas.Clientes);
  const carregar = useCallback(async () => {
    try {
      const d = await api.get('/whatsapp');
      setDados(d);
      if (d.conectado || d.status === 'erro') setMsgs(await api.get('/whatsapp/mensagens'));
    } catch (err) { toast.erro(err); }
  }, [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    if (!dados || !(dados.conectado || dados.status === 'erro')) return undefined;
    const t = setInterval(() => api.get('/whatsapp/mensagens').then(setMsgs).catch(() => {}), 15000);
    return () => clearInterval(t);
  }, [dados]);

  async function finalizar(code, ids) {
    try {
      const r = await api.post('/whatsapp/conectar', { code, waba_id: ids.waba_id, phone_number_id: ids.phone_number_id, coexistencia: ids.coexistencia !== false });
      toast.sucesso(`WhatsApp conectado: ${r.numero || ''}`);
      await carregar();
    } catch (err) { toast.erro(err); } finally { setConectando(false); }
  }

  // Cadastro incorporado da Meta: a janela devolve o code (FB.login) e os ids da conta/numero (postMessage).
  async function conectar() {
    const m = dados.meta;
    if (m.simulador) {
      // servidor de testes: sem Facebook, conecta direto no simulador
      setConectando(true);
      await finalizar('code-simulador', { waba_id: '1110001', phone_number_id: `22200${Date.now() % 100000}` });
      return;
    }
    setConectando(true);
    sessao.current = {};
    const ouvir = (ev) => {
      if (!/facebook\.com$/.test(new URL(ev.origin).hostname)) return;
      try {
        const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
        if (d && d.type === 'WA_EMBEDDED_SIGNUP') {
          if (/^FINISH/.test(d.event)) {
            sessao.current.ids = { waba_id: d.data.waba_id, phone_number_id: d.data.phone_number_id, coexistencia: d.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' || undefined };
            if (sessao.current.code) finalizar(sessao.current.code, sessao.current.ids);
          } else if (d.event === 'CANCEL') {
            toast.erro(new Error(d.data && d.data.current_step ? `conexão cancelada (etapa: ${d.data.current_step})` : 'conexão cancelada'));
            setConectando(false);
          }
        }
      } catch { /* outras mensagens */ }
    };
    window.addEventListener('message', ouvir);
    try {
      const FB = await carregarSdk(m.app_id, m.versao);
      FB.login((resp) => {
        const code = resp && resp.authResponse && resp.authResponse.code;
        if (!code) { setConectando(false); return; }
        sessao.current.code = code;
        if (sessao.current.ids) finalizar(code, sessao.current.ids);
        else setTimeout(() => { if (!sessao.current.ids) { toast.erro(new Error('a Meta não informou o número escolhido: refaça a conexão')); setConectando(false); } }, 8000);
      }, {
        config_id: m.config_id, response_type: 'code', override_default_response_type: true,
        extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
      });
    } catch (err) { toast.erro(err); setConectando(false); } finally { setTimeout(() => window.removeEventListener('message', ouvir), 10 * 60000); }
  }

  async function desconectar() {
    if (!(await confirmar({ titulo: 'Desconectar o WhatsApp?', mensagem: 'O sistema para de mandar os avisos dos pedidos. O número continua funcionando normalmente no WhatsApp Business do celular.', confirmar: 'Desconectar', perigo: true }))) return;
    try { setDados(await api.post('/whatsapp/desconectar', {})); toast.sucesso('WhatsApp desconectado'); } catch (err) { toast.erro(err); }
  }
  async function aviso(evento, ligado) {
    try { setDados(await api.put('/whatsapp/avisos', { avisos: { [evento]: ligado } })); } catch (err) { toast.erro(err); }
  }
  async function conferirModelos() {
    try { setDados(await api.post('/whatsapp/modelos/conferir', {})); toast.sucesso('Situação dos modelos atualizada'); } catch (err) { toast.erro(err); }
  }
  async function testar(e) {
    e.preventDefault();
    setEnviando(true);
    try {
      const r = await api.post('/whatsapp/teste', { telefone: tel });
      toast.sucesso(`Mensagem de teste enviada para +${r.telefone}`);
      setMsgs(await api.get('/whatsapp/mensagens'));
    } catch (err) { toast.erro(err); } finally { setEnviando(false); }
  }

  if (!dados) return <div className="page"><p className="muted">Carregando…</p></div>;
  const m = dados.meta;
  const ligado = dados.conectado || dados.status === 'erro';
  return (
    <div className="page">
      <div className="page-header"><h2>WhatsApp</h2></div>
      {!ligado ? (
        <div className="card wa-conectar">
          <h3>Avise o cliente pelo WhatsApp a cada etapa do pedido</h3>
          <p>Conecte o WhatsApp Business da empresa pela <b>API oficial da Meta</b>. O sistema manda sozinho: <i>pedido recebido</i>, <i>em preparo</i>, <i>pronto para retirar</i>, <i>saiu para entrega</i> (com o nome do entregador) e <i>cancelado</i>.</p>
          <ul className="nf-resumo">
            <li><b>O número continua no celular:</b> com a coexistência, você segue usando o WhatsApp Business no aparelho; as mensagens do sistema aparecem lá também.</li>
            <li>Precisa: o número já estar no app <b>WhatsApp Business</b> (atualizado) e uma conta do Facebook com acesso à empresa.</li>
            <li>Custo (cobrado pela Meta): avisos do pedido são mensagens de “utilidade”, de poucos centavos e grátis quando o cliente falou com a loja nas últimas 24 h.</li>
            <li>Pedidos do iFood e da 99Food não recebem aviso daqui (a própria plataforma avisa o cliente).</li>
          </ul>
          {m.disponivel || m.simulador ? (
            <button type="button" className="btn-primario wa-botao" disabled={conectando} onClick={conectar}>{conectando ? 'Conectando…' : m.simulador ? (user && user.modoTeste ? 'Conectar WhatsApp de teste (simulado)' : 'Conectar WhatsApp (simulador de testes)') : 'Conectar WhatsApp'}</button>
          ) : <p className="error">A integração com a Meta ainda não foi configurada no servidor (aplicativo da Calutec na Meta). Fale com o suporte.</p>}
          <p className="muted">Ao clicar, abre a janela da Meta: entre com o Facebook, escolha a empresa e o número e, no celular, leia o QR Code que aparece (WhatsApp Business → Configurações → Dispositivos conectados).</p>
        </div>
      ) : (
        <>
          <div className="card wa-status">
            <div className="nf-loja-topo">
              <div>
                <h3>{dados.nome || 'WhatsApp'} · {dados.numero}</h3>
                <div className="celula-sub">Conectado em {dataHora(dados.conectado_em)}{dados.coexistencia ? ' · o número continua no WhatsApp Business do celular' : ''}</div>
              </div>
              <div className="nf-selos">
                <span className={`ped-pill ${dados.status === 'conectado' ? 'ok' : 'err'}`}>{dados.status === 'conectado' ? 'Conectado' : 'Precisa reconectar'}</span>
                {m.simulador && <span className="ped-pill warn">Simulador</span>}
              </div>
            </div>
            {dados.ultimo_erro && <p className="error">{dados.ultimo_erro}</p>}
            <div className="row-actions">
              {dados.status === 'erro' && <button type="button" className="btn-primario" disabled={conectando} onClick={conectar}>Reconectar</button>}
              <button type="button" className="btn-link perigo" onClick={desconectar}>Desconectar</button>
            </div>
          </div>

          <div className="card">
            <div className="toolbar" style={{ marginTop: 0 }}>
              <h3 style={{ margin: 0, flex: 1 }}>Avisos do pedido</h3>
              <button type="button" className="btn-link" onClick={conferirModelos}>Atualizar modelos</button>
            </div>
            <p className="muted">Cada aviso usa um modelo de mensagem aprovado pela Meta (normalmente em poucos minutos). Pedidos do site, do cardápio digital e os lançados com o celular do cliente recebem os avisos.</p>
            <div className="wa-avisos">
              {dados.modelos.map((x) => {
                const [nomeSt, cor] = MODELO[x.status] || [x.status, ''];
                return (
                  <label key={x.evento} className="wa-aviso">
                    <input type="checkbox" checked={!!dados.avisos[x.evento]} onChange={(e) => aviso(x.evento, e.target.checked)} />
                    <span className="wa-aviso-corpo">
                      <b>{x.titulo}</b> <span className={`ped-pill ${cor}`}>{nomeSt}</span>
                      <span className="wa-balao">{x.texto.replace('{{1}}', 'Maria').replace('{{2}}', '123').replace('{{3}}', 'sua loja').replace('{{4}}', x.evento === 'saiu_entrega' ? 'João' : 'R$ 45,90')}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {user && user.modoTeste && <CaixaWhatsappTeste />}
          {podeCampanha && <CampanhasWhatsApp inicial={state && state.campanha ? { segmento: state.campanha } : null} />}

          <div className="card">
            <h3>Enviar mensagem de teste</h3>
            <form className="form-grid" onSubmit={testar}>
              <Field label="Celular (com DDD)"><input value={tel} onChange={(e) => setTel(e.target.value)} placeholder="(41) 99999-9999" inputMode="tel" required /></Field>
              <button type="submit" className="btn-primario" disabled={enviando}>{enviando ? 'Enviando…' : 'Enviar teste'}</button>
            </form>
          </div>

          <div className="card">
            <h3>Últimas mensagens</h3>
            {msgs.length === 0 ? <Vazio>Nenhuma mensagem enviada ainda.</Vazio> : (
              <div className="tabela-wrap">
                <table className="tabela-cartoes">
                  <thead><tr><th>Quando</th><th>Aviso</th><th>Pedido</th><th>Para</th><th>Situação</th></tr></thead>
                  <tbody>
                    {msgs.map((x) => {
                      const [nomeSt, cor] = SITUACAO[x.situacao] || [x.situacao, ''];
                      return (
                        <tr key={x.id}>
                          <td>{dataHora(x.criado_em)}</td>
                          <td>{EVENTO[x.evento] || x.evento}</td>
                          <td>{x.pedido_numero ? `#${x.pedido_numero}` : '—'}</td>
                          <td>+{x.telefone}</td>
                          <td><span className={`ped-pill ${cor}`}>{nomeSt}</span>{x.motivo && <div className="celula-sub">{x.motivo}</div>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

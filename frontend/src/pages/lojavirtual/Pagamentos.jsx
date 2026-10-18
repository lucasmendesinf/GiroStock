import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';
import { Field, Vazio } from '../../components/ui.jsx';
import { brl, dataHora } from '../../utils/format';

const NA_ENTREGA = [['dinheiro', 'Dinheiro (com troco)'], ['pix', 'Pix na entrega/retirada'], ['cartao', 'Cartão na maquininha']];
const SITUACAO = { aprovado: ['ok', 'Aprovado'], pendente: ['warn', 'Pendente'], recusado: ['err', 'Recusado'], expirado: ['', 'Expirado'], estornado: ['', 'Estornado'], erro: ['err', 'Erro'] };

// Formas de pagamento do site e a conta do Mercado Pago do lojista (o dinheiro cai direto nela).
export default function Pagamentos({ config, onMudou }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const mp = config.mercadopago;
  const [f, setF] = useState({ ...config.pagamentos, na_entrega: config.pagamentos.na_entrega || [], parcelas_max: String(config.parcelas_max), pix_expira_min: String(config.pix_expira_min) });
  const [cred, setCred] = useState({ access_token: '', public_key: '', webhook_secret: '' });
  const [conectando, setConectando] = useState(false);
  const [lista, setLista] = useState(null);
  const carregar = useCallback(() => api.get('/loja-virtual/pagamentos').then(setLista).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);

  async function salvarFormas(e) {
    e.preventDefault();
    try {
      await api.put('/loja-virtual', { pagamentos: { pix_online: !!f.pix_online, cartao_online: !!f.cartao_online, na_entrega: f.na_entrega }, parcelas_max: Number(f.parcelas_max), pix_expira_min: Number(f.pix_expira_min) });
      toast.sucesso('Formas de pagamento salvas');
      await onMudou();
    } catch (err) { toast.erro(err); }
  }
  async function conectar(e) {
    e.preventDefault();
    setConectando(true);
    try {
      await api.put('/loja-virtual/mercadopago', { access_token: cred.access_token.trim(), public_key: cred.public_key.trim(), ...(cred.webhook_secret.trim() ? { webhook_secret: cred.webhook_secret.trim() } : {}) });
      toast.sucesso('Conta do Mercado Pago conectada');
      setCred({ access_token: '', public_key: '', webhook_secret: '' });
      await onMudou();
    } catch (err) { toast.erro(err); } finally { setConectando(false); }
  }
  async function desconectar() {
    if (!(await confirmar({ titulo: 'Desconectar o Mercado Pago?', mensagem: 'O site deixa de aceitar Pix e cartão online (o pagamento na entrega continua).', confirmar: 'Desconectar', perigo: true }))) return;
    try { await api.del('/loja-virtual/mercadopago'); toast.sucesso('Mercado Pago desconectado'); await onMudou(); } catch (err) { toast.erro(err); }
  }
  async function copiar(t) {
    try { await navigator.clipboard.writeText(t); toast.sucesso('Copiado'); } catch { toast.erro(new Error('não foi possível copiar: selecione e copie')); }
  }
  const marcarNa = (forma, sim) => setF({ ...f, na_entrega: sim ? [...new Set([...f.na_entrega, forma])] : f.na_entrega.filter((x) => x !== forma) });

  return (
    <div className="form-stack">
      <form className="card form-stack" onSubmit={salvarFormas}>
        <h3 style={{ margin: 0 }}>Formas de pagamento no site</h3>
        <div className="lv-pag-grupos">
          <div>
            <span className="ped-rotulo">Pagar no site (Mercado Pago)</span>
            <label className="check"><input type="checkbox" checked={!!f.pix_online} onChange={(e) => setF({ ...f, pix_online: e.target.checked })} /> Pix (QR code / copia e cola)</label>
            <label className="check"><input type="checkbox" checked={!!f.cartao_online} onChange={(e) => setF({ ...f, cartao_online: e.target.checked })} /> Cartão de crédito</label>
            {!mp.conectado && (f.pix_online || f.cartao_online) && <p className="form-hint" style={{ color: 'var(--warn)' }}>Conecte a conta do Mercado Pago abaixo para estas formas aparecerem no site.</p>}
          </div>
          <div>
            <span className="ped-rotulo">Pagar na entrega ou na retirada</span>
            {NA_ENTREGA.map(([k, n]) => <label key={k} className="check"><input type="checkbox" checked={f.na_entrega.includes(k)} onChange={(e) => marcarNa(k, e.target.checked)} /> {n}</label>)}
          </div>
        </div>
        <div className="form-grid">
          <Field label="Parcelas no cartão (até)">
            <select value={f.parcelas_max} onChange={(e) => setF({ ...f, parcelas_max: e.target.value })}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i === 0 ? 'Só à vista' : `${i + 1}x`}</option>)}</select>
          </Field>
          <Field label="Prazo para pagar o Pix (min)" hint="Sem pagamento no prazo, o pedido é cancelado e o estoque liberado."><input inputMode="numeric" value={f.pix_expira_min} onChange={(e) => setF({ ...f, pix_expira_min: e.target.value })} /></Field>
        </div>
        <div><button type="submit" className="btn-primario">Salvar formas</button></div>
      </form>

      <div className="card form-stack">
        <div className="ped-head" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: 0 }}>Conta do Mercado Pago</h3>
          {mp.conectado ? <span className="ped-pill ok">Conectada</span> : <span className="ped-pill">Não conectada</span>}
        </div>
        {mp.conectado ? (
          <>
            <div className="ped-linha"><span>Conta</span><b>{mp.conta}</b></div>
            <div className="ped-linha"><span>Public key</span><code>{mp.public_key}</code></div>
            <div className="ped-linha"><span>Assinatura dos avisos</span><span>{mp.webhook_secret ? 'conferida (segredo cadastrado)' : 'sem segredo: os avisos são conferidos direto na API'}</span></div>
            {mp.public_key.startsWith('TEST-') && <div className="ped-nota">Credenciais de <b>teste</b>: os pagamentos não são reais. Troque pelas de produção para vender.</div>}
          </>
        ) : <p className="form-hint" style={{ margin: 0 }}>No Mercado Pago: <b>Seu negócio → Configurações → Gestão e administração → Credenciais</b> (ou em mercadopago.com.br/developers → Suas integrações). Copie o <b>Access Token</b> e a <b>Public Key</b> de produção.</p>}
        <div className="lv-campo-copiar">
          <span className="ped-rotulo">Endereço para notificações (Webhooks → evento “Pagamentos”)</span>
          <div><code>{config.url_webhook_mp}</code> <button type="button" className="btn-link" onClick={() => copiar(config.url_webhook_mp)}>Copiar</button></div>
        </div>
        <form className="form-stack" onSubmit={conectar}>
          <div className="form-grid">
            <Field label="Access Token *"><input type="password" autoComplete="off" value={cred.access_token} onChange={(e) => setCred({ ...cred, access_token: e.target.value })} placeholder="APP_USR-…" required /></Field>
            <Field label="Public Key *"><input autoComplete="off" value={cred.public_key} onChange={(e) => setCred({ ...cred, public_key: e.target.value })} placeholder="APP_USR-…" required /></Field>
          </div>
          <Field label="Assinatura secreta dos webhooks" hint="Opcional e recomendado: aparece no Mercado Pago depois de salvar o endereço de notificações."><input type="password" autoComplete="off" value={cred.webhook_secret} onChange={(e) => setCred({ ...cred, webhook_secret: e.target.value })} /></Field>
          <div className="lv-acoes">
            <button type="submit" className="btn-primario" disabled={conectando}>{conectando ? 'Conferindo…' : mp.conectado ? 'Trocar credenciais' : 'Conectar'}</button>
            {mp.conectado && <button type="button" className="perigo" onClick={desconectar}>Desconectar</button>}
          </div>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Últimos pagamentos online</h3>
        {!lista ? <p className="muted">Carregando…</p> : lista.length === 0 ? <Vazio>Nenhum pagamento online ainda.</Vazio> : (
          <div className="tabela-wrap">
            <table className="tabela-cartoes">
              <thead><tr><th>Pedido</th><th>Quando</th><th>Forma</th><th className="num">Valor</th><th>Situação</th></tr></thead>
              <tbody>
                {lista.map((p) => {
                  const [cls, txt] = SITUACAO[p.situacao] || ['', p.situacao];
                  return (
                    <tr key={p.id}>
                      <td><b>#{p.numero}</b><div className="celula-sub">{p.cliente_nome}</div></td>
                      <td>{dataHora(p.criado_em)}</td>
                      <td>{p.metodo === 'pix' ? 'Pix' : `Cartão${p.bandeira ? ` ${p.bandeira}` : ''}${p.final_cartao ? ` •${p.final_cartao}` : ''}${p.parcelas > 1 ? ` ${p.parcelas}x` : ''}`}</td>
                      <td className="num">{brl(p.valor)}</td>
                      <td><span className={`ped-pill ${cls}`}>{txt}</span>{p.provedor_id && <div className="celula-sub">MP {p.provedor_id}</div>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

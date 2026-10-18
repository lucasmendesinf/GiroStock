import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';

const SITUACAO_DNS = { ok: ['ok', 'apontando certo'], aponta_outro: ['err', 'aponta para outro lugar'], sem_registro: ['warn', 'ainda sem DNS'], erro: ['warn', 'não deu para consultar'], nao_configurado: ['', 'servidor sem alvo de DNS'] };

// Endereco da loja virtual da empresa: subdominio gratis da plataforma e dominios proprios (o cliente aponta o DNS).
export default function LojaEndereco({ empresaId }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [f, setF] = useState({ subdominio: '', dominios: '' });
  const [dns, setDns] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const carregar = useCallback(() => api.get(`/master/empresas/${empresaId}/loja-virtual`).then((r) => {
    setD(r);
    setF({ subdominio: r.subdominio || '', dominios: r.dominios.join('\n') });
    setDns(null);
  }).catch((err) => toast.erro(err)), [empresaId, toast]);
  useEffect(() => { carregar(); }, [carregar]);
  if (!d) return null;

  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      await api.put(`/master/empresas/${empresaId}/loja-virtual`, { subdominio: f.subdominio.trim() || null, dominios: f.dominios });
      toast.sucesso('Endereço da loja salvo');
      await carregar();
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  async function conferir() {
    try { setDns(await api.get(`/master/empresas/${empresaId}/loja-virtual/dns`)); } catch (err) { toast.erro(err); }
  }
  const alvo = d.dns_alvo && (d.dns_alvo.cname || d.dns_alvo.ip);
  return (
    <div className="ped-sec">
      <span className="ped-rotulo">Loja virtual · endereço</span>
      {!d.modulo_ligado && <div className="cl-sub">O módulo Loja virtual está desligado para esta empresa: o endereço só passa a abrir a loja quando ele for liberado.</div>}
      <form onSubmit={salvar} className="form-stack" style={{ marginTop: 6 }}>
        <label className="field">
          <span className="field-label">Subdomínio grátis</span>
          <div className="lv-sub">
            <input value={f.subdominio} onChange={(e) => setF({ ...f, subdominio: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="nome-da-loja" maxLength={40} />
            <span className="cl-sub">.{d.dominio_base || '(LOJA_DOMINIO_BASE não configurado)'}</span>
          </div>
        </label>
        <label className="field">
          <span className="field-label">Domínios próprios (um por linha)</span>
          <textarea rows={2} value={f.dominios} onChange={(e) => setF({ ...f, dominios: e.target.value })} placeholder="www.lojadocliente.com.br" />
        </label>
        <div className="cl-linha-btn" style={{ justifyContent: 'flex-start' }}>
          <button type="submit" className="btn-primario" disabled={salvando}>Salvar endereço</button>
          {d.dominios.length > 0 && <button type="button" className="btn-link" onClick={conferir}>Conferir DNS</button>}
        </div>
      </form>
      {(d.url_subdominio || d.urls_dominios.length > 0) && (
        <div style={{ marginTop: 8 }}>
          {[d.url_subdominio, ...d.urls_dominios].filter(Boolean).map((u) => <div key={u} className="ped-linha"><a className="lv-link" href={u} target="_blank" rel="noreferrer">{u}</a></div>)}
        </div>
      )}
      {dns && dns.dominios.map((x) => {
        const [cls, txt] = SITUACAO_DNS[x.situacao] || ['', x.situacao];
        return <div key={x.dominio} className="ped-linha"><span>{x.dominio}</span><span className={`ped-pill ${cls}`} title={x.mensagem}>{txt}</span></div>;
      })}
      {d.dominios.length > 0 && (
        <div className="ped-nota" style={{ marginTop: 8 }}>
          <b>Passe para o cliente</b> (no Registro.br ou onde o domínio foi comprado):<br />
          {alvo ? <>
            • <code>www</code> → registro <b>CNAME</b> apontando para <code>{d.dns_alvo.cname || d.dns_alvo.ip}</code>{d.dns_alvo.ip && d.dns_alvo.cname ? <> (ou registro A para <code>{d.dns_alvo.ip}</code>)</> : null}<br />
            • domínio sem www → redirecionar para o www{d.dns_alvo.ip ? <> (ou registro <b>A</b> para <code>{d.dns_alvo.ip}</code>)</> : null}<br />
          </> : <>Configure LOJA_DNS_ALVO/LOJA_DNS_IP no servidor para mostrar o destino do DNS.<br /></>}
          No servidor (cPanel): adicione cada domínio como “domínio adicional/alias” do mesmo aplicativo para o certificado (cadeado) ser gerado.
        </div>
      )}
    </div>
  );
}

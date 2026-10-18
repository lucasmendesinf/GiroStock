import { useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { brl, parseNumero } from '../../utils/format';
import { enviarImagem } from '../../utils/imagem';

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const valor = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

// Situacao, o que falta, dados da loja, funcionamento e a ligacao com o site (chave da API).
export default function Geral({ dados, onMudou }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const c = dados.config;
  const r = dados.resumo;

  async function salvar(corpo, msg) {
    try {
      await api.put('/loja-virtual', corpo);
      toast.sucesso(msg);
      await onMudou();
      return true;
    } catch (err) { toast.erro(err); return false; }
  }
  async function publicar(sim) {
    if (!sim && !(await confirmar({ titulo: 'Tirar a loja do ar?', mensagem: 'O site mostra a loja como fora do ar e não aceita pedidos até você publicar de novo.', confirmar: 'Tirar do ar', perigo: true }))) return;
    await salvar({ publicada: sim }, sim ? 'Loja publicada' : 'Loja fora do ar');
  }

  return (
    <div className="form-stack">
      <div className="ped-kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="ped-kpi hero"><small>Vendido no site este mês</small><b>{brl(r.vendido_mes)}</b><span className="cl-sub">{r.pedidos_hoje} pedido(s) hoje</span></div>
        <div className="ped-kpi"><small>Produtos no site</small><b>{r.produtos_publicados}</b><span className="cl-sub">publicados</span></div>
        <div className="ped-kpi"><small>Clientes do site</small><b>{r.clientes}</b><span className="cl-sub">com conta</span></div>
        <div className="ped-kpi"><small>Bairros de entrega</small><b>{r.bairros}</b><span className="cl-sub">{c.taxa_outros_bairros !== null ? `outros: ${brl(c.taxa_outros_bairros)}` : 'só os cadastrados'}</span></div>
      </div>

      <div className="card">
        <div className="ped-head" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Situação da loja</h3>
          <div className="lv-acoes">
            {c.publicada && <button type="button" onClick={() => salvar({ pausada: !c.pausada }, c.pausada ? 'Loja voltou a receber pedidos' : 'Loja pausada: o site não aceita pedidos')}>{c.pausada ? 'Retomar pedidos' : 'Pausar pedidos'}</button>}
            {c.publicada
              ? <button type="button" className="perigo" onClick={() => publicar(false)}>Tirar do ar</button>
              : <button type="button" className="btn-primario" onClick={() => publicar(true)}>Publicar loja</button>}
          </div>
        </div>
        <p style={{ margin: '4px 0' }}>
          {!c.publicada ? 'A loja está fora do ar: o site mostra a página de loja fechada.'
            : c.pausada ? 'A loja está no ar, mas pausada: os clientes veem os produtos e não conseguem pedir.'
              : dados.situacao.ok ? 'A loja está no ar e recebendo pedidos.' : `A loja está no ar, mas não recebe pedidos agora: ${dados.situacao.motivo}.`}
        </p>
        {dados.pendencias.length > 0 && (
          <div className="ped-nota">
            <b>Para a loja funcionar:</b>
            <ul className="lv-pendencias">{dados.pendencias.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        )}
      </div>

      <DadosDaLoja c={c} salvar={salvar} />
      <Funcionamento c={c} locais={dados.locais} salvar={salvar} />
      <Integracao c={c} onMudou={onMudou} />
    </div>
  );
}

function DadosDaLoja({ c, salvar }) {
  const toast = useToast();
  const [f, setF] = useState({ nome: c.nome, descricao: c.descricao, whatsapp: c.whatsapp, telefone: c.telefone, email: c.email, endereco: c.endereco, instagram: c.instagram, aviso: c.aviso, site_maior_idade: !!c.site_maior_idade });
  const [logo, setLogo] = useState({ id: c.logo_id, url: c.logo_url });
  const [enviando, setEnviando] = useState(false);
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function trocarLogo(e) {
    const arq = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!arq) return;
    setEnviando(true);
    try { setLogo(await enviarImagem(arq, 600)); } catch (err) { toast.erro(err); } finally { setEnviando(false); }
  }
  return (
    <form className="card form-stack" onSubmit={(e) => { e.preventDefault(); salvar({ ...f, logo_id: logo.id || null }, 'Dados da loja salvos'); }}>
      <h3 style={{ margin: 0 }}>Dados da loja (aparecem no site)</h3>
      <div className="lv-logo">
        <div className="lv-logo-img">{logo.url ? <img src={logo.url} alt="Logo da loja" /> : <span className="muted">sem logo</span>}</div>
        <div>
          <label className="btn-link lv-arquivo">{enviando ? 'Enviando…' : logo.url ? 'Trocar logo' : 'Enviar logo'}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={trocarLogo} disabled={enviando} /></label>
          {logo.url && <button type="button" className="btn-link perigo" onClick={() => setLogo({ id: null, url: null })}>Remover</button>}
          <div className="form-hint">PNG com fundo transparente fica melhor. Salve para valer.</div>
        </div>
      </div>
      <div className="form-grid">
        <Field label="Nome da loja *"><input value={f.nome} onChange={mudar('nome')} maxLength={80} required /></Field>
        <Field label="WhatsApp"><input value={f.whatsapp} onChange={mudar('whatsapp')} inputMode="tel" placeholder="(11) 99999-0000" maxLength={30} /></Field>
      </div>
      <Field label="Descrição" hint="Uma ou duas frases sobre a loja."><textarea rows={2} value={f.descricao} onChange={mudar('descricao')} maxLength={600} /></Field>
      <div className="form-grid">
        <Field label="Telefone"><input value={f.telefone} onChange={mudar('telefone')} inputMode="tel" maxLength={30} /></Field>
        <Field label="E-mail"><input type="email" value={f.email} onChange={mudar('email')} maxLength={120} /></Field>
      </div>
      <div className="form-grid">
        <Field label="Endereço (retirada)"><input value={f.endereco} onChange={mudar('endereco')} maxLength={200} /></Field>
        <Field label="Instagram"><input value={f.instagram} onChange={mudar('instagram')} placeholder="@minhaloja" maxLength={80} /></Field>
      </div>
      <Field label="Aviso no topo do site" hint="Ex.: Entregas até as 23h. Deixe vazio para não mostrar."><input value={f.aviso} onChange={mudar('aviso')} maxLength={200} /></Field>
      <label className="check"><input type="checkbox" checked={f.site_maior_idade} onChange={(e) => setF({ ...f, site_maior_idade: e.target.checked })} /> Site para maiores de 18 anos: perguntar a idade ao entrar (ex.: tabacaria)</label>
      <div><button type="submit" className="btn-primario">Salvar dados</button></div>
    </form>
  );
}

function faixasIniciais(h) {
  return DIAS.map((_, d) => {
    const lista = (h && h[d]) || [];
    return { aberto: lista.length > 0, faixas: lista.length ? lista.map((x) => ({ ...x })) : [{ de: '18:00', ate: '23:00' }] };
  });
}

function Funcionamento({ c, locais, salvar }) {
  const cardapio = c.tipo === 'cardapio';
  const [f, setF] = useState({
    location_id: c.location_id || '', aceita_retirada: c.aceita_retirada, aceita_entrega: c.aceita_entrega,
    tempo_preparo_min: String(c.tempo_preparo_min), tempo_entrega_min: String(c.tempo_entrega_min), pedido_minimo: valor(c.pedido_minimo),
  });
  const [sempre, setSempre] = useState(Object.keys(c.horarios || {}).length === 0);
  const [dias, setDias] = useState(faixasIniciais(c.horarios));
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const mudarDia = (d, fn) => setDias(dias.map((x, i) => (i === d ? fn(x) : x)));
  const local = locais.find((l) => l.id === f.location_id);
  function enviar(e) {
    e.preventDefault();
    const horarios = {};
    if (!sempre) dias.forEach((x, d) => { if (x.aberto) horarios[d] = x.faixas; });
    salvar({
      location_id: f.location_id || null, aceita_retirada: f.aceita_retirada, aceita_entrega: f.aceita_entrega,
      tempo_preparo_min: Number(f.tempo_preparo_min), tempo_entrega_min: Number(f.tempo_entrega_min), pedido_minimo: parseNumero(f.pedido_minimo) || 0, horarios,
    }, 'Funcionamento salvo');
  }
  return (
    <form className="card form-stack" onSubmit={enviar}>
      <h3 style={{ margin: 0 }}>Funcionamento</h3>
      <Field label="Estabelecimento da loja virtual *" hint={cardapio ? 'O estoque dele define o que aparece como disponível no site, e os pedidos caem na tela de Pedidos dele.' : 'O estoque dele define o que aparece como disponível no site. Os pedidos ficam na aba Pedidos do site.'}>
        <select value={f.location_id} onChange={mudar('location_id')}>
          <option value="">Escolha…</option>
          {locais.map((l) => <option key={l.id} value={l.id}>{l.nome}{l.usa_pedidos || !cardapio ? '' : ' (ative "usar pedidos" em Lojas & PDVs)'}</option>)}
        </select>
      </Field>
      {cardapio && local && !local.usa_pedidos && <p className="form-hint" style={{ color: 'var(--warn)', margin: 0 }}>Este estabelecimento ainda não usa pedidos: ative em Lojas &amp; PDVs antes de salvar.</p>}
      <div className="lv-linha-checks">
        <label className="check"><input type="checkbox" checked={f.aceita_retirada} onChange={mudar('aceita_retirada')} /> Retirada na loja</label>
        <label className="check"><input type="checkbox" checked={f.aceita_entrega} onChange={mudar('aceita_entrega')} /> Entrega (delivery)</label>
      </div>
      <div className="form-grid lv-grid-3">
        <Field label="Preparo (min)"><input inputMode="numeric" value={f.tempo_preparo_min} onChange={mudar('tempo_preparo_min')} /></Field>
        <Field label="Entrega (min)"><input inputMode="numeric" value={f.tempo_entrega_min} onChange={mudar('tempo_entrega_min')} /></Field>
        <Field label="Pedido mínimo (R$)"><input inputMode="decimal" value={f.pedido_minimo} onChange={mudar('pedido_minimo')} placeholder="0,00" /></Field>
      </div>
      <div>
        <span className="ped-rotulo">Horário de funcionamento</span>
        <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={sempre} onChange={(e) => setSempre(e.target.checked)} /> Sempre aberta (sem horário)</label>
        {!sempre && (
          <div className="lv-horarios">
            {dias.map((x, d) => (
              <div key={DIAS[d]} className={`lv-dia ${x.aberto ? '' : 'fechado'}`}>
                <label className="check"><input type="checkbox" checked={x.aberto} onChange={(e) => mudarDia(d, (y) => ({ ...y, aberto: e.target.checked }))} /> {DIAS[d]}</label>
                {x.aberto ? (
                  <div className="lv-faixas">
                    {x.faixas.map((fx, i) => (
                      <span key={i} className="lv-faixa">
                        <input type="time" value={fx.de} aria-label={`${DIAS[d]} abre`} onChange={(e) => mudarDia(d, (y) => ({ ...y, faixas: y.faixas.map((z, j) => (j === i ? { ...z, de: e.target.value } : z)) }))} />
                        <span className="muted">às</span>
                        <input type="time" value={fx.ate} aria-label={`${DIAS[d]} fecha`} onChange={(e) => mudarDia(d, (y) => ({ ...y, faixas: y.faixas.map((z, j) => (j === i ? { ...z, ate: e.target.value } : z)) }))} />
                        {x.faixas.length > 1 && <button type="button" className="btn-link perigo" aria-label="Remover faixa" onClick={() => mudarDia(d, (y) => ({ ...y, faixas: y.faixas.filter((_, j) => j !== i) }))}>×</button>}
                      </span>
                    ))}
                    {x.faixas.length < 3 && <button type="button" className="btn-link" onClick={() => mudarDia(d, (y) => ({ ...y, faixas: [...y.faixas, { de: '11:00', ate: '14:00' }] }))}>+ faixa</button>}
                  </div>
                ) : <span className="muted">fechada</span>}
              </div>
            ))}
            <p className="form-hint">Para passar da meia-noite, use o fim menor que o início (ex.: 18:00 às 02:00).</p>
          </div>
        )}
      </div>
      <div><button type="submit" className="btn-primario">Salvar funcionamento</button></div>
    </form>
  );
}

function Integracao({ c, onMudou }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [novaChave, setNovaChave] = useState(null);
  const enderecos = [...(c.urls_dominios || []), c.url_subdominio, c.url_link].filter(Boolean);
  const [qr, setQr] = useState(null);
  async function verQr() {
    try { setQr(await api.get(`/loja-virtual/qrcode?url=${encodeURIComponent(c.link_principal)}`)); } catch (err) { toast.erro(err); }
  }
  async function gerar() {
    if (c.chave && !(await confirmar({ titulo: 'Gerar uma nova chave?', mensagem: 'A chave atual para de funcionar na hora: um site externo que use a chave fica fora até receber a nova.', confirmar: 'Gerar nova chave', perigo: true }))) return;
    try {
      setNovaChave((await api.post('/loja-virtual/chave')).chave);
      await onMudou();
    } catch (err) { toast.erro(err); }
  }
  async function copiar(t) {
    try { await navigator.clipboard.writeText(t); toast.sucesso('Copiado'); } catch { toast.erro(new Error('não foi possível copiar: selecione e copie')); }
  }
  return (
    <div className="card form-stack">
      <h3 style={{ margin: 0 }}>Link da loja</h3>
      {c.link_principal ? (
        <>
          <p className="form-hint" style={{ margin: 0 }}>Mande para os clientes, coloque no status e na bio do WhatsApp/Instagram ou imprima o QR code no balcão.</p>
          <div className="lv-link-principal">
            <a href={c.link_principal} target="_blank" rel="noreferrer"><code>{c.link_principal}</code></a>
            <div className="lv-acoes">
              <button type="button" className="btn-primario" onClick={() => copiar(c.link_principal)}>Copiar link</button>
              <a className="btn-link" href={`https://wa.me/?text=${encodeURIComponent(`Faça seu pedido pelo nosso site: ${c.link_principal}`)}`} target="_blank" rel="noreferrer">Enviar pelo WhatsApp</a>
              <button type="button" className="btn-link" onClick={verQr}>QR code</button>
            </div>
          </div>
          {enderecos.length > 1 && (
            <div className="lv-campo-copiar">
              <span className="ped-rotulo">Outros endereços que abrem a mesma loja</span>
              {enderecos.filter((u) => u !== c.link_principal).map((u) => <div key={u}><a href={u} target="_blank" rel="noreferrer"><code>{u}</code></a> <button type="button" className="btn-link" onClick={() => copiar(u)}>Copiar</button></div>)}
            </div>
          )}
          <p className="form-hint" style={{ margin: 0 }}>Para usar um domínio próprio (ex.: www.minhaloja.com.br), fale com o suporte.</p>
        </>
      ) : <p className="form-hint" style={{ margin: 0 }}>O endereço da loja ainda não foi definido: fale com o suporte.</p>}
      {qr && (
        <Modal titulo="QR code da loja" subtitulo={qr.url} onClose={() => setQr(null)}
          acoes={<><a className="btn-link" href={qr.qr} download="qrcode-loja.png">Baixar imagem</a><button type="button" className="btn-primario" onClick={() => setQr(null)}>Fechar</button></>}>
          <img src={qr.qr} alt={`QR code para ${qr.url}`} className="lv-qr" />
        </Modal>
      )}
      {c.url_previa && <div><a className="btn-link" href={c.url_previa} target="_blank" rel="noreferrer">Pré-visualizar a loja ↗</a> <span className="form-hint">funciona mesmo com a loja fora do ar</span></div>}
      <details className="lv-avancado">
        <summary>Site externo (avançado): chave da API</summary>
        <p className="form-hint">Só é necessária se a loja for montada num site feito à parte. O site padrão já funciona sem chave.</p>
        <div className="lv-campo-copiar">
          <span className="ped-rotulo">Endereço da API</span>
          <div><code>{c.url_api}</code> <button type="button" className="btn-link" onClick={() => copiar(c.url_api)}>Copiar</button></div>
        </div>
        <div className="lv-campo-copiar">
          <span className="ped-rotulo">Chave da API</span>
          <div>
            {c.chave ? <><code>{c.chave.prefixo}…</code> <span className="muted">criada em {new Date(c.chave.criada_em).toLocaleDateString('pt-BR')}</span></> : <span className="muted">nenhuma chave</span>}
            {' '}<button type="button" className="btn-link" onClick={gerar}>{c.chave ? 'Gerar nova chave' : 'Gerar chave'}</button>
          </div>
        </div>
      </details>
      {novaChave && (
        <Modal titulo="Chave da API gerada" subtitulo="Copie agora: por segurança ela não aparece de novo." onClose={() => setNovaChave(null)}
          acoes={<><button type="button" onClick={() => copiar(novaChave)}>Copiar chave</button><button type="button" className="btn-primario" onClick={() => setNovaChave(null)}>Já copiei</button></>}>
          <code className="lv-chave">{novaChave}</code>
          <p className="form-hint">Configure no site externo o cabeçalho <code>X-Loja-Chave</code> com esta chave. Se ela vazar, gere uma nova (a antiga deixa de funcionar).</p>
        </Modal>
      )}
    </div>
  );
}

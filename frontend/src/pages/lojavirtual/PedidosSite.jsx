import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field, Modal, Vazio } from '../../components/ui.jsx';
import { brl, dataHora, fmtTel, qtd } from '../../utils/format';

// Pedidos do site da loja online (varejo): separar, embalar, enviar com rastreio e entregar, sem a tela de Pedidos.
// Pedido pago no site vira venda quando sai (enviado ou retirado), sem caixa; a pagar na loja, ao finalizar, no caixa aberto.
const FILTROS = [
  ['abertos', 'Em aberto'], ['a_preparar', 'A preparar'], ['aguardando_pagamento', 'Aguardando pagamento'], ['em_separacao', 'Em separação'],
  ['prontos', 'Prontos'], ['enviados', 'Enviados'], ['concluidos', 'Concluídos'], ['cancelados', 'Cancelados'], ['todos', 'Todos'],
];
const COR = { a_preparar: 'warn', aguardando_pagamento: '', em_separacao: 'warn', aguardando_envio: 'warn', pronto_retirada: 'ok', enviado: 'ok', entregue: 'ok', retirado: 'ok', cancelado: 'err' };
const TRANSPORTADORAS = ['Correios', 'Jadlog', 'Loggi', 'J&T Express', 'Total Express', 'Azul Cargo', 'Entrega própria'];
const METODO = { pix: 'Pix', cartao: 'Cartão' };
const NA_LOJA = { dinheiro: 'Dinheiro', pix: 'Pix', cartao: 'Cartão' };
const SIT_PAG = { aprovado: 'pago', pendente: 'aguardando', recusado: 'recusado', expirado: 'expirado', estornado: 'estornado' };

export function rotuloAcao(p) {
  if (p.proxima === 'em_preparo') return 'Iniciar separação';
  if (p.proxima === 'pronto') return p.tipo === 'entrega' ? 'Marcar como embalado' : 'Pronto para retirada';
  if (p.proxima === 'saiu_entrega') return 'Enviar';
  if (p.proxima === 'finalizado') return p.tipo === 'entrega' ? 'Marcar como entregue' : 'Cliente retirou';
  return null;
}
const pagamentoTexto = (pg, tipo) => (pg.tipo === 'online'
  ? `${METODO[pg.metodo] || pg.metodo} pelo site · ${SIT_PAG[pg.situacao] || pg.situacao}`
  : `${NA_LOJA[pg.forma] || pg.forma || 'A combinar'} na ${tipo === 'entrega' ? 'entrega' : 'retirada'}${pg.pago ? ' · pago' : ''}`);

export default function PedidosSite({ onMudou }) {
  const toast = useToast();
  const [filtro, setFiltro] = useState('abertos');
  const [busca, setBusca] = useState('');
  const [dados, setDados] = useState(null);
  const [aberto, setAberto] = useState(null);
  const carregar = useCallback(() => api.get(`/loja-virtual/pedidos?situacao=${filtro}${busca.trim() ? `&busca=${encodeURIComponent(busca.trim())}` : ''}`)
    .then(setDados).catch((err) => toast.erro(err)), [filtro, busca, toast]);
  useEffect(() => { const t = setTimeout(carregar, busca ? 250 : 0); return () => clearTimeout(t); }, [carregar, busca]);
  useEffect(() => { const t = setInterval(carregar, 30000); return () => clearInterval(t); }, [carregar]);
  const mudou = () => { carregar(); if (onMudou) onMudou(); };

  return (
    <div className="card">
      <div className="ped-head" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}>Pedidos do site</h3></div>
      <p className="form-hint" style={{ marginTop: 0 }}>
        Separe, embale e envie com o código de rastreio. O cliente acompanha cada etapa no site e recebe e-mail quando o pedido é enviado ou fica pronto para retirada.
      </p>
      <div className="es-chips" role="group" aria-label="Situação">
        {FILTROS.map(([k, nome]) => (
          <button key={k} type="button" className={`es-chip ${filtro === k ? 'on' : ''}`} onClick={() => setFiltro(k)}>
            {nome}{dados && dados.contagem[k] > 0 && k !== 'todos' ? ` (${dados.contagem[k]})` : ''}
          </button>
        ))}
      </div>
      <input type="search" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nº, cliente, telefone ou rastreio" aria-label="Buscar pedido" style={{ width: '100%' }} />
      {!dados ? <p className="muted">Carregando…</p> : dados.pedidos.length === 0 ? <Vazio>Nenhum pedido {busca ? 'encontrado' : 'nesta situação'}.</Vazio> : (
        <div className="tabela-wrap" style={{ marginTop: 10 }}>
          <table className="tabela-cartoes">
            <thead><tr><th>Pedido</th><th>Cliente</th><th>Entrega</th><th className="num">Total</th><th>Pagamento</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {dados.pedidos.map((p) => (
                <tr key={p.id} className="linha-clicavel" onClick={() => setAberto(p.id)}>
                  <td><b>nº {p.numero}</b><div className="celula-sub">{dataHora(p.criado_em)}</div></td>
                  <td>{p.cliente_nome}<div className="celula-sub">{fmtTel(p.cliente_telefone)}</div></td>
                  <td>{p.tipo === 'entrega' ? 'Envio' : 'Retirada'}<div className="celula-sub">{p.itens} {p.itens === 1 ? 'item' : 'itens'}</div></td>
                  <td className="num">{brl(p.total)}</td>
                  <td>{pagamentoTexto(p.pagamento, p.tipo)}</td>
                  <td><span className={`ped-pill ${COR[p.situacao] || ''}`}>{p.situacao_nome}</span>{p.rastreio && p.rastreio.codigo && <div className="celula-sub">{p.rastreio.codigo}</div>}</td>
                  <td className="num">{rotuloAcao(p) && <button type="button" className="btn-link" onClick={(e) => { e.stopPropagation(); setAberto(p.id); }}>{rotuloAcao(p)} ›</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {aberto && <DetalhePedido id={aberto} onClose={() => setAberto(null)} onMudou={mudou} />}
    </div>
  );
}

function DetalhePedido({ id, onClose, onMudou }) {
  const toast = useToast();
  const [p, setP] = useState(null);
  const [envio, setEnvio] = useState(null); // formulario de envio/rastreio
  const [forma, setForma] = useState('');
  const [cancelando, setCancelando] = useState(null);
  const [salvando, setSalvando] = useState(false);
  useEffect(() => { api.get(`/loja-virtual/pedidos/${id}`).then(setP).catch((err) => { toast.erro(err); onClose(); }); }, [id, toast, onClose]);
  if (!p) return <Modal titulo="Pedido do site" onClose={onClose}><p className="muted">Carregando…</p></Modal>;

  const precisaForma = p.proxima === 'finalizado' && p.pagamento.tipo !== 'online' && !p.pagamento.pago;
  async function executar(fn, msg) {
    setSalvando(true);
    try { setP(await fn()); toast.sucesso(msg); onMudou(); setEnvio(null); setCancelando(null); } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  function avancar() {
    if (p.proxima === 'saiu_entrega') return setEnvio({ transportadora: 'Correios', rastreio_codigo: '', rastreio_url: '' });
    const corpo = { para: p.proxima };
    if (precisaForma) {
      const f = p.pagamento.forma === 'cartao' ? forma : p.pagamento.forma;
      if (!f) return toast.erro('Escolha se o cartão foi crédito ou débito');
      corpo.forma_pagamento = f;
    }
    return executar(() => api.post(`/loja-virtual/pedidos/${p.id}/avancar`, corpo), rotuloAcao(p) === 'Iniciar separação' ? 'Separação iniciada' : 'Pedido atualizado');
  }
  function enviar(e) {
    e.preventDefault();
    const jaEnviado = p.status === 'saiu_entrega' || p.status === 'finalizado';
    executar(
      () => (jaEnviado ? api.put(`/loja-virtual/pedidos/${p.id}/rastreio`, { ...envio, avisar_cliente: true }) : api.post(`/loja-virtual/pedidos/${p.id}/avancar`, { para: 'saiu_entrega', ...envio })),
      jaEnviado ? 'Rastreio atualizado' : 'Pedido enviado: o cliente foi avisado',
    );
  }
  function imprimir() {
    const w = window.open('', '_blank', 'width=720,height=900');
    if (!w) return;
    const esc = (t) => String(t === null || t === undefined ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Pedido ${p.numero}</title><style>
      body{font:14px system-ui,sans-serif;margin:24px;color:#111} h1{font-size:20px;margin:0 0 4px} table{width:100%;border-collapse:collapse;margin-top:12px}
      td,th{border-bottom:1px solid #ccc;padding:6px 4px;text-align:left} .n{text-align:right} .box{border:1px solid #999;padding:10px;margin-top:12px}</style></head><body>
      <h1>Pedido nº ${p.numero}</h1><div>${esc(dataHora(p.criado_em))} · ${p.tipo === 'entrega' ? 'Envio' : 'Retirada na loja'}</div>
      <div class="box"><b>${esc(p.cliente_nome)}</b> · ${esc(fmtTel(p.cliente_telefone))}${p.endereco ? `<br>${esc(p.endereco)}` : ''}</div>
      <table><tr><th>✔</th><th>Qtd</th><th>Produto</th><th>Código</th></tr>${p.itens.map((i) => `<tr><td>☐</td><td>${esc(qtd(i.quantidade, i.unidade))}</td><td>${esc(i.nome)}${i.complementos.length ? `<br><small>${esc(i.complementos.map((c) => c.nome).join(', '))}</small>` : ''}${i.observacao ? `<br><small>Obs.: ${esc(i.observacao)}</small>` : ''}</td><td>${esc(i.codigo || '')}</td></tr>`).join('')}</table>
      ${p.observacao ? `<div class="box">Observação: ${esc(p.observacao)}</div>` : ''}<script>window.print()</script></body></html>`);
    w.document.close();
  }

  const acao = rotuloAcao(p);
  return (
    <Modal
      titulo={`Pedido nº ${p.numero}`}
      subtitulo={<><span className={`ped-pill ${COR[p.situacao] || ''}`}>{p.situacao_nome}</span> · {dataHora(p.criado_em)} · {p.tipo === 'entrega' ? 'Envio' : 'Retirada na loja'}</>}
      onClose={onClose}
      largura="larga"
      acoes={(
        <>
          {p.pode_cancelar && <button type="button" className="btn-link perigo" onClick={() => setCancelando('')} disabled={salvando}>Cancelar pedido</button>}
          <button type="button" className="btn-link" onClick={imprimir}>Imprimir separação</button>
          {acao && <button type="button" onClick={avancar} disabled={salvando}>{acao}</button>}
        </>
      )}
    >
      <div className="form-stack">
        {p.situacao === 'aguardando_pagamento' && <p className="form-hint" style={{ margin: 0 }}>Aguardando o cliente pagar no site. A separação libera assim que o pagamento for aprovado.</p>}
        {precisaForma && p.pagamento.forma === 'cartao' && (
          <Field label="Cartão recebido como">
            <select value={forma} onChange={(e) => setForma(e.target.value)}><option value="">Escolha…</option><option value="cartao_credito">Crédito</option><option value="cartao_debito">Débito</option></select>
          </Field>
        )}
        {precisaForma && <p className="form-hint" style={{ margin: 0 }}>O pagamento é recebido na {p.tipo === 'entrega' ? 'entrega' : 'retirada'}: a venda entra no caixa aberto da loja.</p>}

        {envio && (
          <form className="card form-stack" onSubmit={enviar} style={{ margin: 0 }}>
            <b>Dados do envio</b>
            <div className="form-grid">
              <Field label="Transportadora">
                <input list="lv-transportadoras" value={envio.transportadora} onChange={(e) => setEnvio({ ...envio, transportadora: e.target.value })} required maxLength={60} />
              </Field>
              <Field label="Código de rastreio" hint="Opcional (entrega própria não tem)">
                <input value={envio.rastreio_codigo} onChange={(e) => setEnvio({ ...envio, rastreio_codigo: e.target.value.toUpperCase() })} maxLength={60} placeholder="Ex.: AA123456789BR" />
              </Field>
            </div>
            <Field label="Link para acompanhar" hint="Opcional: o cliente vê um botão “Acompanhar entrega” no site">
              <input type="url" value={envio.rastreio_url} onChange={(e) => setEnvio({ ...envio, rastreio_url: e.target.value })} placeholder="https://…" />
            </Field>
            <datalist id="lv-transportadoras">{TRANSPORTADORAS.map((t) => <option key={t} value={t} />)}</datalist>
            <div className="botoes-linha">
              <button type="button" className="btn-link" onClick={() => setEnvio(null)}>Voltar</button>
              <button type="submit" disabled={salvando}>{p.status === 'pronto' ? 'Confirmar envio' : 'Salvar rastreio'}</button>
            </div>
          </form>
        )}
        {cancelando !== null && (
          <form className="card form-stack" onSubmit={(e) => { e.preventDefault(); executar(() => api.post(`/loja-virtual/pedidos/${p.id}/cancelar`, { motivo: cancelando }), 'Pedido cancelado'); }} style={{ margin: 0 }}>
            <Field label="Motivo do cancelamento" hint={p.pagamento.tipo === 'online' && p.pagamento.situacao === 'aprovado' ? 'O valor pago volta para o cliente pelo Mercado Pago.' : undefined}>
              <input value={cancelando} onChange={(e) => setCancelando(e.target.value)} required minLength={3} maxLength={200} autoFocus />
            </Field>
            <div className="botoes-linha">
              <button type="button" className="btn-link" onClick={() => setCancelando(null)}>Voltar</button>
              <button type="submit" className="perigo" disabled={salvando}>Cancelar pedido</button>
            </div>
          </form>
        )}

        <div className="form-grid">
          <div>
            <div className="field-label">Cliente</div>
            <b>{p.cliente_nome}</b>
            <div className="celula-sub">{fmtTel(p.cliente_telefone)}{p.cliente_email ? ` · ${p.cliente_email}` : ''}</div>
            {p.cliente_telefone && <a className="btn-link" href={`https://wa.me/55${String(p.cliente_telefone).replace(/\D/g, '')}?text=${encodeURIComponent(`Olá! Sobre o seu pedido nº ${p.numero}`)}`} target="_blank" rel="noreferrer">WhatsApp ↗</a>}
          </div>
          <div>
            <div className="field-label">{p.tipo === 'entrega' ? 'Endereço de entrega' : 'Retirada'}</div>
            {p.tipo === 'entrega' ? p.endereco : 'O cliente retira na loja'}
          </div>
        </div>

        {p.rastreio && (
          <div>
            <div className="field-label">Envio</div>
            {p.rastreio.transportadora}{p.rastreio.codigo && <> · <b>{p.rastreio.codigo}</b></>}{p.rastreio.url && <> · <a href={p.rastreio.url} target="_blank" rel="noreferrer">acompanhar ↗</a></>}
            {p.enviado_em && <span className="celula-sub"> · enviado {dataHora(p.enviado_em)}</span>}
            {!envio && <> · <button type="button" className="btn-link" onClick={() => setEnvio({ transportadora: p.rastreio.transportadora || '', rastreio_codigo: p.rastreio.codigo || '', rastreio_url: p.rastreio.url || '' })}>Corrigir</button></>}
          </div>
        )}

        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Produto</th><th className="num">Qtd</th><th className="num">Preço</th><th className="num">Subtotal</th></tr></thead>
            <tbody>
              {p.itens.map((i, n) => (
                <tr key={n}>
                  <td>{i.nome}{i.codigo && <div className="celula-sub">cód. {i.codigo}</div>}{i.complementos.length > 0 && <div className="celula-sub">{i.complementos.map((c) => `${c.quantidade > 1 ? `${c.quantidade}x ` : ''}${c.nome}`).join(', ')}</div>}{i.observacao && <div className="celula-sub">Obs.: {i.observacao}</div>}</td>
                  <td className="num">{qtd(i.quantidade, i.unidade)}</td>
                  <td className="num">{brl(i.preco_unitario)}</td>
                  <td className="num">{brl(i.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="lv-resumo-pedido">
          <div><span>Produtos</span><span>{brl(p.subtotal)}</span></div>
          {p.tipo === 'entrega' && <div><span>Frete</span><span>{p.taxa_entrega > 0 ? brl(p.taxa_entrega) : 'Grátis'}</span></div>}
          {p.desconto > 0 && <div><span>Desconto{p.cupom ? ` (${p.cupom})` : ''}</span><span>− {brl(p.desconto)}</span></div>}
          <div className="total"><span>Total</span><b>{brl(p.total)}</b></div>
          <div className="celula-sub">
            {pagamentoTexto(p.pagamento, p.tipo)}
            {p.pagamento.detalhe && p.pagamento.detalhe.parcelas > 1 ? ` · ${p.pagamento.detalhe.parcelas}x` : ''}
            {p.pagamento.detalhe && p.pagamento.detalhe.bandeira ? ` · ${p.pagamento.detalhe.bandeira}${p.pagamento.detalhe.final_cartao ? ` •${p.pagamento.detalhe.final_cartao}` : ''}` : ''}
            {p.pagamento.troco_para ? ` · troco para ${brl(p.pagamento.troco_para)}` : ''}
            {p.venda_numero ? ` · venda nº ${p.venda_numero}` : ''}
          </div>
        </div>
        {p.observacao && <p style={{ margin: 0 }}><span className="field-label">Observação do cliente</span><br />{p.observacao}</p>}
        {p.motivo_cancelamento && <p style={{ margin: 0 }} className="erro-texto">Cancelado: {p.motivo_cancelamento}</p>}

        <details>
          <summary>Histórico</summary>
          <ul className="lv-historico">
            {p.historico.map((h, i) => <li key={i}><span>{h.nome}</span><span className="celula-sub">{dataHora(h.em)}{h.por ? ` · ${h.por}` : ''}</span></li>)}
          </ul>
        </details>
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/UiContext.jsx';
import { Field, Modal } from '../components/ui.jsx';
import { PAGAMENTOS } from '../components/PedidoForm.jsx';
import { textoComplementos } from '../components/EscolherComplementos.jsx';
import { brl, dataHora, parseNumero } from '../utils/format';

// Comandas (caixa/gerencia): as comandas de mesa e pista abertas pelos garcons; as que pediram fechamento ficam no topo.
// "Receber e fechar" gera UMA venda com todos os itens das rodadas e baixa o estoque.
const NOME_STATUS = { aberta: 'Aberta', fechamento_solicitado: 'Pediu fechamento', paga: 'Paga', cancelada: 'Cancelada' };
const NOME_RODADA = { novo: 'Na cozinha', em_preparo: 'Em preparo', pronto: 'Pronta', entregue: 'Entregue', finalizado: 'Paga', cancelado: 'Cancelada' };
const INTERVALO_MS = 15000;

export default function Comandas() {
  const toast = useToast();
  const { user } = useAuth();
  const [lista, setLista] = useState(null);
  const [status, setStatus] = useState('abertas');
  const [loja, setLoja] = useState('');
  const [lojas, setLojas] = useState([]);
  const [busca, setBusca] = useState('');
  const [aberta, setAberta] = useState(null); // detalhe da comanda
  const [fechando, setFechando] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [motivo, setMotivo] = useState(null); // comanda a cancelar
  const gerente = !!user?.areas?.CancelarVendas;

  useEffect(() => { api.get('/locations').then((l) => setLojas(l.filter((x) => x.ativo && x.usa_pedidos))).catch(() => {}); }, []);

  const carregar = useCallback(async () => {
    const qs = new URLSearchParams({ status });
    if (loja) qs.set('location_id', loja);
    if (busca.trim()) qs.set('q', busca.trim());
    try { setLista(await api.get(`/comandas?${qs.toString()}`)); } catch (err) { toast.erro(err); }
  }, [status, loja, busca, toast]);
  useEffect(() => { const t = setTimeout(carregar, 200); return () => clearTimeout(t); }, [carregar]);
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) carregar(); }, INTERVALO_MS); return () => clearInterval(t); }, [carregar]);

  async function abrir(c) {
    try { setAberta(await api.get(`/comandas/${c.id}`)); } catch (err) { toast.erro(err); }
  }
  async function recarregarAberta(id) {
    try { setAberta(await api.get(`/comandas/${id}`)); } catch { setAberta(null); }
    carregar();
  }
  async function reabrir(c) {
    try { await api.post(`/garcom/comandas/${c.id}/reabrir`); toast.sucesso('Comanda reaberta: o garçom pode lançar mais pedidos.'); recarregarAberta(c.id); } catch (err) { toast.erro(err); }
  }

  const pedindo = (lista || []).filter((c) => c.status === 'fechamento_solicitado').length;
  const totalAbertas = (lista || []).filter((c) => ['aberta', 'fechamento_solicitado'].includes(c.status)).reduce((s, c) => s + Number(c.total), 0);

  return (
    <div className="page">
      <div className="page-header"><h2>Comandas</h2></div>
      <div className="ped-kpis">
        <div className="ped-kpi" style={pedindo > 0 ? { borderColor: 'var(--warn)' } : undefined}><small>Pediram fechamento</small><b>{pedindo}</b></div>
        <div className="ped-kpi"><small>Comandas abertas</small><b>{(lista || []).filter((c) => ['aberta', 'fechamento_solicitado'].includes(c.status)).length}</b></div>
        <div className="ped-kpi"><small>Consumo em aberto</small><b>{brl(totalAbertas)}</b></div>
      </div>
      <div className="ped-bar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação" style={{ width: 'auto' }}>
          <option value="abertas">Abertas</option><option value="fechamento_solicitado">Pediram fechamento</option><option value="paga">Pagas</option><option value="cancelada">Canceladas</option>
        </select>
        {lojas.length > 1 && <select value={loja} onChange={(e) => setLoja(e.target.value)} aria-label="Loja" style={{ width: 'auto' }}><option value="">Todas as lojas</option>{lojas.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select>}
        <input className="ped-busca" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar mesa, pulseira ou nome" aria-label="Buscar comanda" />
      </div>
      <div className="card">
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Comanda</th><th>Garçom</th><th>Rodadas</th><th>Aberta em</th><th>Total</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {(lista || []).map((c) => (
                <tr key={c.id} className={c.status === 'fechamento_solicitado' ? 'cmd-fechando' : ''}>
                  <td><b>{c.tipo === 'pista' ? '🎫' : '🍽'} {c.identificador}</b><div className="cl-sub">#{c.numero}{c.cliente_nome ? ` · ${c.cliente_nome}` : ''} · {c.location_nome}</div></td>
                  <td>{c.garcons.map((g) => g.nome).join(', ') || c.aberta_por_nome || '—'}</td>
                  <td>{c.rodadas}{c.rodadas_na_cozinha > 0 && <span className="ped-pill warn" style={{ marginLeft: 6 }}>{c.rodadas_na_cozinha} na cozinha</span>}</td>
                  <td>{dataHora(c.aberta_em)}</td>
                  <td><b>{brl(c.total)}</b></td>
                  <td><span className={`ped-pill ${c.status === 'fechamento_solicitado' ? 'warn' : c.status === 'paga' ? 'ok' : c.status === 'cancelada' ? 'err' : ''}`}>{NOME_STATUS[c.status]}</span></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn-link" onClick={() => abrir(c)}>Ver</button>{' '}
                    {['aberta', 'fechamento_solicitado'].includes(c.status) && c.rodadas > 0 && <button type="button" className="btn-link" onClick={async () => { try { setFechando(await api.get(`/comandas/${c.id}`)); } catch (err) { toast.erro(err); } }}>Receber e fechar</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {lista && lista.length === 0 && <div className="ped-vazio">Nenhuma comanda neste filtro</div>}
      </div>

      {aberta && (
        <Modal titulo={`${aberta.identificador} · #${aberta.numero}`} subtitulo={`${aberta.location_nome} · ${NOME_STATUS[aberta.status]}`} onClose={() => setAberta(null)} largura="larga">
          <div className="form-stack">
            {aberta.rodadas_lista.map((r) => (
              <div key={r.id} className="card" style={{ margin: 0, padding: 12 }}>
                <div className="cl-sub"><b>Rodada {r.rodada}</b> · pedido #{r.pedido_numero} · {dataHora(r.criado_em)} · <span className="ped-pill">{NOME_RODADA[r.status]}</span></div>
                {r.itens.map((i) => (
                  <div key={i.id} className="ped-linha"><span>{Number(i.quantidade)}× {i.product_nome}{i.complementos.length > 0 ? ` ${textoComplementos(i.complementos)}` : ''}{i.observacao ? ` — “${i.observacao}”` : ''}{i.garcom_nome ? <em className="cl-sub"> · {i.garcom_nome}</em> : null}</span><span>{brl(i.subtotal)}</span></div>
                ))}
                {r.motivo_cancelamento && <div className="cl-sub">Motivo: {r.motivo_cancelamento}</div>}
              </div>
            ))}
            <div className="ped-linha" style={{ fontSize: 18 }}><b>Total da comanda</b><b>{brl(aberta.total)}</b></div>
            <div className="modal-actions">
              {aberta.status === 'fechamento_solicitado' && gerente && <button type="button" onClick={() => reabrir(aberta)}>Reabrir para o garçom</button>}
              {['aberta', 'fechamento_solicitado'].includes(aberta.status) && gerente && <button type="button" className="perigo" onClick={() => setMotivo(aberta)}>Cancelar comanda</button>}
              {['aberta', 'fechamento_solicitado'].includes(aberta.status) && aberta.rodadas > 0 && <button type="button" onClick={() => { setFechando(aberta); setAberta(null); }}>Receber e fechar</button>}
              <button type="button" onClick={() => setAberta(null)}>Fechar</button>
            </div>
          </div>
        </Modal>
      )}

      {fechando && <FecharComanda comanda={fechando} onClose={() => setFechando(null)} onFeito={(r) => { setFechando(null); setResultado(r); carregar(); }} />}
      {resultado && (
        <Modal titulo="Comanda paga" subtitulo={`${resultado.comanda.identificador} · venda nº ${resultado.venda.numero}`} onClose={() => setResultado(null)}>
          <div className="form-stack">
            <div className="ped-linha" style={{ fontSize: 18 }}><b>Total recebido</b><b>{brl(resultado.venda.total)}</b></div>
            {resultado.venda.troco !== null && resultado.venda.troco !== undefined && <div className="ped-linha"><span>Troco</span><b>{brl(resultado.venda.troco)}</b></div>}
            <div className="cl-sub">As rodadas foram finalizadas e o estoque baixou uma única vez.</div>
            <div className="modal-actions"><button type="button" onClick={() => setResultado(null)}>Ok</button></div>
          </div>
        </Modal>
      )}
      {motivo && <MotivoCancelar comanda={motivo} onClose={() => setMotivo(null)} onFeito={() => { setMotivo(null); setAberta(null); carregar(); toast.sucesso('Comanda cancelada.'); }} />}
    </div>
  );
}

function FecharComanda({ comanda, onClose, onFeito }) {
  const toast = useToast();
  const { user } = useAuth();
  const [terminais, setTerminais] = useState([]);
  const [terminalId, setTerminalId] = useState('');
  const [pagamento, setPagamento] = useState('pix');
  const [recebido, setRecebido] = useState('');
  const [desconto, setDesconto] = useState('');
  const [salvando, setSalvando] = useState(false);
  const podeDesconto = !!user?.areas?.Desconto;

  useEffect(() => {
    api.get('/terminals').then((t) => {
      const da = t.filter((x) => x.ativo && x.location_id === comanda.location_id);
      setTerminais(da);
      const aberto = da.find((x) => x.caixa_aberto);
      if (aberto) setTerminalId(aberto.id);
    }).catch((e) => toast.erro(e));
  }, [comanda.location_id, toast]);

  const total = Math.max(0, Number(comanda.total) - (podeDesconto ? parseNumero(desconto || '0') || 0 : 0));
  const forma = (PAGAMENTOS.find((p) => p.id === pagamento) || {}).forma || 'pix';
  const troco = forma === 'dinheiro' && recebido ? parseNumero(recebido) - total : null;

  async function fechar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      const r = await api.post(`/comandas/${comanda.id}/fechar`, {
        terminal_id: terminalId, forma_pagamento: forma,
        ...(forma === 'dinheiro' ? { valor_recebido: parseNumero(recebido || '0') } : {}),
        ...(podeDesconto && desconto ? { desconto: parseNumero(desconto) } : {}),
      });
      onFeito(r);
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  const semCaixa = terminais.length > 0 && !terminais.some((t) => t.caixa_aberto);
  return (
    <Modal titulo={`Receber ${comanda.identificador}`} subtitulo={`Comanda #${comanda.numero} · ${comanda.rodadas} rodada(s)`} onClose={onClose}>
      <form onSubmit={fechar} className="form-stack">
        <Field label="Caixa que recebe">
          <select value={terminalId} onChange={(e) => setTerminalId(e.target.value)} required>
            <option value="">Escolha…</option>
            {terminais.map((t) => <option key={t.id} value={t.id} disabled={!t.caixa_aberto}>{t.nome}{t.caixa_aberto ? '' : ' (caixa fechado)'}</option>)}
          </select>
        </Field>
        {semCaixa && <div className="cl-sub" style={{ color: 'var(--warn)' }}>Nenhum caixa aberto nesta loja: abra o caixa no PDV para receber a comanda.</div>}
        <Field label="Forma de pagamento">
          <select value={pagamento} onChange={(e) => setPagamento(e.target.value)}>{PAGAMENTOS.map((p) => <option key={p.id} value={p.id}>{p.nome.replace('Pagar ', '').replace('no ', '')}</option>)}</select>
        </Field>
        {podeDesconto && <Field label="Desconto (R$)" hint="Opcional"><input inputMode="decimal" value={desconto} onChange={(e) => setDesconto(e.target.value)} placeholder="0,00" /></Field>}
        {forma === 'dinheiro' && <Field label="Valor recebido (R$)"><input inputMode="decimal" value={recebido} onChange={(e) => setRecebido(e.target.value)} placeholder={String(total).replace('.', ',')} required /></Field>}
        <div className="ped-linha" style={{ fontSize: 18 }}><b>Total a receber</b><b>{brl(total)}</b></div>
        {troco !== null && <div className="ped-linha"><span>{troco >= 0 ? 'Troco' : 'Falta'}</span><b>{brl(Math.abs(troco))}</b></div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" disabled={salvando || !terminalId || (forma === 'dinheiro' && !(parseNumero(recebido || '0') >= total))}>{salvando ? 'Fechando…' : 'Receber e fechar'}</button>
        </div>
      </form>
    </Modal>
  );
}

function MotivoCancelar({ comanda, onClose, onFeito }) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);
  async function enviar(e) {
    e.preventDefault();
    setSalvando(true);
    try { await api.post(`/garcom/comandas/${comanda.id}/cancelar`, { motivo: motivo.trim() }); onFeito(); } catch (err) { toast.erro(err); setSalvando(false); }
  }
  return (
    <Modal titulo={`Cancelar ${comanda.identificador}`} subtitulo="Cancela as rodadas que ainda não foram entregues e libera a reserva do estoque." onClose={onClose}>
      <form onSubmit={enviar} className="form-stack">
        <Field label="Motivo"><input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} minLength={3} maxLength={200} required /></Field>
        <div className="modal-actions"><button type="button" onClick={onClose}>Voltar</button><button type="submit" disabled={salvando || motivo.trim().length < 3}>Cancelar comanda</button></div>
      </form>
    </Modal>
  );
}

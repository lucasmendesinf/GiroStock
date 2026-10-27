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
  const [aba, setAba] = useState('comandas');

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
      <div className="ped-bar" role="tablist">
        <button type="button" role="tab" aria-selected={aba === 'comandas'} className={`btn-link ${aba === 'comandas' ? 'ativo' : ''}`} onClick={() => setAba('comandas')}>Comandas</button>
        <button type="button" role="tab" aria-selected={aba === 'prestacao'} className={`btn-link ${aba === 'prestacao' ? 'ativo' : ''}`} onClick={() => setAba('prestacao')}>Prestação de contas</button>
      </div>
      {aba === 'prestacao' ? <Prestacao /> : <>
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
      </>}
      {motivo && <MotivoCancelar comanda={motivo} onClose={() => setMotivo(null)} onFeito={() => { setMotivo(null); setAberta(null); carregar(); toast.sucesso('Comanda cancelada.'); }} />}
    </div>
  );
}

const NOME_FORMA = { pix: 'Pix', cartao_credito: 'Cartão crédito', cartao_debito: 'Cartão débito', dinheiro: 'Dinheiro' };
const arred = (v) => Math.round(Number(v) * 100) / 100;

// Fechar no caixa: cobra so o RESTANTE (o que o garcom ja recebeu no app aparece como pago), com desconto so sobre o restante,
// taxa de servico opcional e a possibilidade de dividir o restante em mais de uma forma de pagamento.
function FecharComanda({ comanda, onClose, onFeito }) {
  const toast = useToast();
  const { user } = useAuth();
  const [terminais, setTerminais] = useState([]);
  const [terminalId, setTerminalId] = useState('');
  const [desconto, setDesconto] = useState('');
  const [taxa, setTaxa] = useState(false);
  const [partes, setPartes] = useState([{ forma: 'pix', valor: '', recebido: '' }]);
  const [salvando, setSalvando] = useState(false);
  const podeDesconto = !!user?.areas?.Desconto;
  const pct = Number((comanda.receber && comanda.receber.taxa_servico_pct) || 0);
  const pagosApp = (comanda.pagamentos || []).filter((p) => p.status === 'confirmado');

  useEffect(() => {
    api.get('/terminals').then((t) => {
      const da = t.filter((x) => x.ativo && x.location_id === comanda.location_id);
      setTerminais(da);
      const aberto = da.find((x) => x.caixa_aberto);
      if (aberto) setTerminalId(aberto.id);
    }).catch((e) => toast.erro(e));
  }, [comanda.location_id, toast]);

  const restante = arred(comanda.falta_produtos);
  const descNum = podeDesconto ? arred(parseNumero(desconto || '0') || 0) : 0;
  const taxaRestante = taxa && restante > 0 ? arred((restante - descNum) * pct / 100) : 0;
  const aCobrar = restante > 0 ? arred(restante - descNum + taxaRestante) : 0;
  const valorDe = (p, i) => (partes.length === 1 ? aCobrar : arred(parseNumero(p.valor || '0') || 0));
  const soma = arred(partes.reduce((s, p, i) => s + valorDe(p, i), 0));
  const falta = arred(aCobrar - soma);
  const trocoDe = (p, i) => (p.forma === 'dinheiro' && p.recebido ? arred((parseNumero(p.recebido) || 0) - valorDe(p, i)) : null);
  const dinheiroInsuf = partes.some((p, i) => p.forma === 'dinheiro' && p.recebido && trocoDe(p, i) < 0);
  const totalVenda = arred(Number(comanda.total) - descNum + Number(comanda.taxa_paga) + taxaRestante);

  const mudar = (i, k, v) => setPartes(partes.map((p, j) => (j === i ? { ...p, [k]: v } : p)));

  async function fechar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      const corpo = { terminal_id: terminalId, desconto: podeDesconto && descNum > 0 ? descNum : undefined, cobrar_taxa: taxa };
      if (aCobrar > 0) corpo.pagamentos = partes.map((p, i) => ({ forma: p.forma, valor: valorDe(p, i), ...(p.forma === 'dinheiro' && p.recebido ? { valor_recebido: parseNumero(p.recebido) } : {}) }));
      onFeito(await api.post(`/comandas/${comanda.id}/fechar`, corpo));
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  const semCaixa = terminais.length > 0 && !terminais.some((t) => t.caixa_aberto);
  return (
    <Modal titulo={`Receber ${comanda.identificador}`} subtitulo={`Comanda #${comanda.numero} · ${comanda.rodadas} rodada(s)`} onClose={onClose}>
      <form onSubmit={fechar} className="form-stack">
        {pagosApp.length > 0 && (
          <div className="card" style={{ margin: 0, padding: 12 }}>
            <div className="cl-sub"><b>Já pago no app pelo garçom</b></div>
            {pagosApp.map((p) => <div key={p.id} className="ped-linha"><span>{NOME_FORMA[p.forma]} · rodada(s) {(p.rodadas || []).join(', ')}{p.forma === 'dinheiro' && !p.prestado_em ? ' · dinheiro com o garçom' : ''}</span><span>{brl(Number(p.valor_produtos) + Number(p.taxa_servico))}</span></div>)}
          </div>
        )}
        <Field label="Caixa que recebe">
          <select value={terminalId} onChange={(e) => setTerminalId(e.target.value)} required>
            <option value="">Escolha…</option>
            {terminais.map((t) => <option key={t.id} value={t.id} disabled={!t.caixa_aberto}>{t.nome}{t.caixa_aberto ? '' : ' (caixa fechado)'}</option>)}
          </select>
        </Field>
        {semCaixa && <div className="cl-sub" style={{ color: 'var(--warn)' }}>Nenhum caixa aberto nesta loja: abra o caixa no PDV para receber a comanda.</div>}
        <div className="ped-linha"><span>Restante das rodadas não pagas</span><b>{brl(restante)}</b></div>
        {restante > 0 && podeDesconto && <Field label="Desconto (R$)" hint="Só sobre o restante"><input inputMode="decimal" value={desconto} onChange={(e) => setDesconto(e.target.value)} placeholder="0,00" /></Field>}
        {restante > 0 && pct > 0 && <label className="check"><input type="checkbox" checked={taxa} onChange={(e) => setTaxa(e.target.checked)} /> Cobrar taxa de serviço ({pct}%) sobre o restante · {brl(arred((restante - descNum) * pct / 100))}</label>}
        {aCobrar > 0 && partes.map((p, i) => (
          <div key={i} className="card" style={{ margin: 0, padding: 12 }}>
            <div className="form-grid">
              <Field label={partes.length > 1 ? `Forma ${i + 1}` : 'Forma de pagamento'}>
                <select value={p.forma} onChange={(e) => mudar(i, 'forma', e.target.value)}>{Object.entries(NOME_FORMA).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
              </Field>
              {partes.length > 1 && <Field label="Valor (R$)"><input inputMode="decimal" value={p.valor} onChange={(e) => mudar(i, 'valor', e.target.value)} placeholder="0,00" required /></Field>}
              {p.forma === 'dinheiro' && <Field label="Valor recebido (R$)"><input inputMode="decimal" value={p.recebido} onChange={(e) => mudar(i, 'recebido', e.target.value)} placeholder={String(valorDe(p, i)).replace('.', ',')} /></Field>}
            </div>
            {trocoDe(p, i) !== null && <div className="cl-sub">{trocoDe(p, i) >= 0 ? `Troco ${brl(trocoDe(p, i))}` : `Faltam ${brl(-trocoDe(p, i))}`}</div>}
            {partes.length > 1 && <button type="button" className="btn-link perigo" onClick={() => setPartes(partes.filter((_, j) => j !== i))}>Remover esta forma</button>}
          </div>
        ))}
        {aCobrar > 0 && <button type="button" className="btn-link" onClick={() => setPartes([...(partes.length === 1 ? [{ ...partes[0], valor: String(aCobrar).replace('.', ',') }] : partes), { forma: 'dinheiro', valor: '', recebido: '' }])}>+ Dividir em mais uma forma de pagamento</button>}
        {partes.length > 1 && aCobrar > 0 && <div className="cl-sub" style={falta !== 0 ? { color: 'var(--warn)' } : undefined}>{falta === 0 ? 'A soma das formas fecha o restante.' : falta > 0 ? `Faltam ${brl(falta)} para fechar o restante.` : `Passou ${brl(-falta)} do restante.`}</div>}
        <div className="ped-linha" style={{ fontSize: 18 }}><b>A cobrar agora</b><b>{brl(aCobrar)}</b></div>
        <div className="cl-sub">Total da venda: {brl(totalVenda)}{Number(comanda.taxa_paga) + taxaRestante > 0 ? ` (inclui taxa de serviço ${brl(Number(comanda.taxa_paga) + taxaRestante)})` : ''}</div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" disabled={salvando || !terminalId || (aCobrar > 0 && (falta !== 0 || dinheiroInsuf))}>{salvando ? 'Fechando…' : aCobrar > 0 ? 'Receber e fechar' : 'Fechar (tudo já pago)'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Prestacao de contas: o dinheiro que os garcons receberam no app e ainda esta com eles. O valor conferido vira SUPRIMENTO no caixa aberto
// (so entao entra no caixa esperado); a diferenca (sobra/falta) fica registrada.
function Prestacao() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [prestando, setPrestando] = useState(null);
  const carregar = useCallback(async () => { try { setD(await api.get('/comandas/prestacao')); } catch (err) { toast.erro(err); } }, [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) carregar(); }, 20000); return () => clearInterval(t); }, [carregar]);

  const hoje = d ? d.hoje : [];
  const soma = (fn) => arred(hoje.filter(fn).reduce((s, r) => s + r.total, 0));
  return (
    <div>
      <div className="ped-kpis">
        <div className="ped-kpi"><small>Recebido na hora pelos garçons (hoje)</small><b>{brl(soma(() => true))}</b></div>
        <div className="ped-kpi" style={d && d.dinheiro_com_garcons > 0 ? { borderColor: 'var(--warn)' } : undefined}><small>Dinheiro com os garçons</small><b style={{ color: 'var(--warn)' }}>{brl(d ? d.dinheiro_com_garcons : 0)}</b></div>
        <div className="ped-kpi"><small>Pix e cartão (já no sistema)</small><b>{brl(soma((r) => r.forma !== 'dinheiro'))}</b></div>
      </div>
      <div className="card">
        <h4 style={{ margin: '0 0 8px' }}>Dinheiro com os garçons</h4>
        {d && d.garcons.length === 0 && <div className="ped-vazio">Nenhum garçom com dinheiro a prestar</div>}
        {(d ? d.garcons : []).map((g) => (
          <div key={g.garcom_id} className="ped-linha" style={{ alignItems: 'center' }}>
            <span><b>{g.garcom_nome}</b> <span className="cl-sub">· {g.recebimentos.length} recebimento(s)</span></span>
            <span><b>{brl(g.total)}</b>{' '}<button type="button" className="btn-link" onClick={() => setPrestando(g)}>Receber prestação de contas…</button></span>
          </div>
        ))}
      </div>
      <div className="card">
        <h4 style={{ margin: '0 0 8px' }}>Recebimentos recentes</h4>
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Quando</th><th>Garçom</th><th>Comanda</th><th>Forma</th><th>Valor</th><th>Situação</th></tr></thead>
            <tbody>
              {(d ? d.recebimentos : []).map((r) => (
                <tr key={r.id}>
                  <td>{dataHora(r.recebido_em)}</td><td>{r.garcom_nome}</td><td>{r.identificador} <span className="cl-sub">#{r.comanda_numero}</span></td><td>{NOME_FORMA[r.forma]}</td><td><b>{brl(r.total)}</b></td>
                  <td>{r.status === 'estornado' ? <span className="ped-pill err">Estornado</span> : r.forma !== 'dinheiro' ? <span className="ped-pill ok">No sistema</span> : r.prestado_em ? <span className="ped-pill ok">Entregue ao caixa{r.diferenca_prestacao && Number(r.diferenca_prestacao) !== 0 ? ` (dif. ${brl(r.diferenca_prestacao)})` : ''}</span> : <span className="ped-pill warn">Com o garçom</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {d && d.recebimentos.length === 0 && <div className="ped-vazio">Nenhum recebimento nos últimos dias</div>}
      </div>
      {prestando && <ReceberPrestacao garcom={prestando} onClose={() => setPrestando(null)} onFeito={() => { setPrestando(null); carregar(); }} />}
    </div>
  );
}

function ReceberPrestacao({ garcom, onClose, onFeito }) {
  const toast = useToast();
  const [terminais, setTerminais] = useState([]);
  const [terminalId, setTerminalId] = useState('');
  const [conferido, setConferido] = useState('');
  const [salvando, setSalvando] = useState(false);
  useEffect(() => {
    api.get('/terminals').then((t) => { const abertos = t.filter((x) => x.ativo && x.caixa_aberto); setTerminais(abertos); if (abertos.length === 1) setTerminalId(abertos[0].id); }).catch((e) => toast.erro(e));
  }, [toast]);
  const dif = conferido === '' ? null : arred((parseNumero(conferido) || 0) - garcom.total);
  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    try { await api.post('/comandas/prestacao', { garcom_id: garcom.garcom_id, valor_conferido: parseNumero(conferido || '0'), terminal_id: terminalId }); toast.sucesso('Prestação de contas recebida: o valor entrou no caixa.'); onFeito(); } catch (err) { toast.erro(err); setSalvando(false); }
  }
  return (
    <Modal titulo={`Prestação de contas · ${garcom.garcom_nome}`} subtitulo={`${garcom.recebimentos.length} recebimento(s) em dinheiro`} onClose={onClose}>
      <form onSubmit={salvar} className="form-stack">
        {garcom.recebimentos.map((r) => <div key={r.id} className="ped-linha"><span>{r.identificador} <span className="cl-sub">#{r.comanda_numero} · {dataHora(r.recebido_em)}</span></span><span>{brl(r.total)}</span></div>)}
        <div className="ped-linha" style={{ fontSize: 18 }}><b>Valor esperado</b><b>{brl(garcom.total)}</b></div>
        <Field label="Caixa que recebe o dinheiro"><select value={terminalId} onChange={(e) => setTerminalId(e.target.value)} required><option value="">Escolha…</option>{terminais.map((t) => <option key={t.id} value={t.id}>{t.nome} — {t.location_nome}</option>)}</select></Field>
        {terminais.length === 0 && <div className="cl-sub" style={{ color: 'var(--warn)' }}>Nenhum caixa aberto: abra o caixa no PDV para receber a prestação.</div>}
        <Field label="Valor conferido (R$)" hint="O que o garçom entregou. Vira suprimento no caixa."><input inputMode="decimal" value={conferido} onChange={(e) => setConferido(e.target.value)} placeholder={String(garcom.total).replace('.', ',')} required /></Field>
        {dif !== null && <div className="ped-linha"><span>{dif === 0 ? 'Sem diferença' : dif > 0 ? 'Sobra' : 'Falta'}</span><b style={dif !== 0 ? { color: 'var(--warn)' } : undefined}>{brl(Math.abs(dif))}</b></div>}
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button type="submit" disabled={salvando || !terminalId || conferido === ''}>{salvando ? 'Registrando…' : 'Receber prestação'}</button></div>
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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Field, Modal } from '../components/ui.jsx';
import PedidoForm, { NOME_ORIGEM, vendaDoPedido } from '../components/PedidoForm.jsx';
import Cupom, { imprimirCupom, configDaVenda } from '../components/Cupom.jsx';
import { brl, dataHora, parseNumero, qtd } from '../utils/format';

const COLUNAS = [
  ['novo', 'Novo', 'novo'],
  ['em_preparo', 'Em preparo', 'prep'],
  ['pronto', 'Pronto', 'pronto'],
  ['saiu_entrega', 'Saiu p/ entrega', 'rota'],
  ['finalizado', 'Finalizado', 'fim'],
];
const NOME_STATUS = { novo: 'Novo', em_preparo: 'Em preparo', pronto: 'Pronto', saiu_entrega: 'Saiu p/ entrega', finalizado: 'Finalizado', cancelado: 'Cancelado' };
const ORIGENS_FILTRO = [['todas', 'Todas as origens'], ['balcao', 'Balcão'], ['telefone', 'Telefone'], ['whatsapp', 'WhatsApp']];
// iFood e 99Food: filtros prontos para a etapa de integracao (ficam ocultos por enquanto).
const ATRASO_MIN = 25;
const INTERVALO_MS = 15000;

const proximo = (p) => ({ novo: 'em_preparo', em_preparo: 'pronto', pronto: p.tipo === 'entrega' ? 'saiu_entrega' : 'finalizado', saiu_entrega: 'finalizado' })[p.status];
const textoAcao = (p) => ({ novo: 'Iniciar preparo', em_preparo: 'Marcar pronto', pronto: p.tipo === 'entrega' ? 'Saiu p/ entrega' : 'Entregue ao cliente', saiu_entrega: 'Entregue ao cliente' })[p.status] || '';
const aberto = (p) => !['finalizado', 'cancelado'].includes(p.status);


export default function Pedidos() {
  const toast = useToast();
  const { user } = useAuth();
  const [lojas, setLojas] = useState([]);
  const [lojaId, setLojaId] = useState('');
  const [pedidos, setPedidos] = useState([]);
  const [buscadoEm, setBuscadoEm] = useState(Date.now());
  const [agora, setAgora] = useState(Date.now());
  const [visao, setVisao] = useState('quadro');
  const [origem, setOrigem] = useState('todas');
  const [busca, setBusca] = useState('');
  const [aberta, setAberta] = useState(null); // id do pedido na gaveta
  const [detalhe, setDetalhe] = useState(null);
  const [novoAberto, setNovoAberto] = useState(false);
  const [receber, setReceber] = useState(null);
  const [cancelar, setCancelar] = useState(null);
  const [destino, setDestino] = useState(null);
  const [escolherEntregador, setEscolherEntregador] = useState(null);
  const [entregadoresAberto, setEntregadoresAberto] = useState(false);
  const [entregadores, setEntregadores] = useState([]);
  const [cupom, setCupom] = useState(null);

  // Lojas que usam pedidos e que o usuario pode ver.
  useEffect(() => {
    api.get('/locations').then((l) => {
      const permitidas = user.perfil === 'Administrador' || !user.locationIds || user.locationIds.length === 0 ? null : user.locationIds;
      const uteis = l.filter((x) => x.ativo && x.usa_pedidos && (!permitidas || permitidas.includes(x.id)));
      setLojas(uteis);
      setLojaId((atual) => atual || (uteis[0] ? uteis[0].id : ''));
    }).catch((err) => toast.erro(err));
  }, [user, toast]);

  const carregar = useCallback(async () => {
    if (!lojaId) return;
    try {
      const lista = await api.get(`/orders?location_id=${lojaId}`);
      setPedidos(lista);
      setBuscadoEm(Date.now());
      setAgora(Date.now());
    } catch (err) { toast.erro(err); }
  }, [lojaId, toast]);

  // Atualizacao automatica (ponto de extensao: trocar por WebSocket/SSE quando houver iFood/99Food).
  useEffect(() => {
    carregar();
    const t = setInterval(carregar, INTERVALO_MS);
    return () => clearInterval(t);
  }, [carregar]);
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const recarregarEntregadores = useCallback(() => api.get('/couriers?todos=1').then(setEntregadores).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { recarregarEntregadores(); }, [recarregarEntregadores]);

  const minutos = (p) => p.minutos_etapa + Math.max(0, Math.floor((agora - buscadoEm) / 60000));
  const atrasado = (p) => ['novo', 'em_preparo'].includes(p.status) && minutos(p) > ATRASO_MIN;

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return pedidos.filter((p) => (origem === 'todas' || p.origem === origem)
      && (!q || `${p.numero} ${p.cliente_nome} ${p.cliente_telefone}`.toLowerCase().includes(q)));
  }, [pedidos, origem, busca]);

  const conta = (s) => pedidos.filter((p) => p.status === s).length;
  const atrasados = pedidos.filter(atrasado).length;

  // Detalhe da gaveta (itens, andamento): recarrega ao abrir e depois de cada acao.
  const abrirDetalhe = useCallback(async (id) => {
    setAberta(id);
    try { setDetalhe(await api.get(`/orders/${id}`)); } catch (err) { toast.erro(err); setAberta(null); }
  }, [toast]);

  // Vindo do PDV ("Ver em Pedidos"): abre direto a gaveta do pedido.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const id = location.state && location.state.abrir;
    if (id) { abrirDetalhe(id); navigate('/pedidos', { replace: true, state: null }); }
  }, [location.state, navigate, abrirDetalhe]);

  async function executar(promessa, mensagem) {
    try {
      const atualizado = await promessa;
      if (mensagem) toast.sucesso(mensagem(atualizado));
      await carregar();
      if (aberta) setDetalhe(await api.get(`/orders/${aberta}`));
      return atualizado;
    } catch (err) {
      toast.erro(err);
      return null;
    }
  }

  function avancar(p, extra = {}) {
    const para = proximo(p);
    if (para === 'saiu_entrega' && !p.entregador_id && !extra.entregador_id) { setEscolherEntregador(p); return; }
    if (para === 'finalizado' && !p.pago && !extra.forma_pagamento) { setReceber(p); return; }
    executar(api.post(`/orders/${p.id}/status`, { para, ...extra }), (r) => `Pedido #${r.numero} → ${NOME_STATUS[r.status]}${r.status === 'finalizado' ? ' · reserva convertida em baixa definitiva do estoque' : ''}`);
  }

  async function imprimir(id) {
    try {
      const p = await api.get(`/orders/${id}`);
      imprimirCupom(setCupom, vendaDoPedido(p), 'cozinha', (m) => toast.sucesso(m));
    } catch (err) { toast.erro(err); }
  }

  async function aoCriar(p) {
    setNovoAberto(false);
    toast.sucesso(`Pedido #${p.numero} criado · estoque reservado`);
    await carregar();
    const cfg = configDaVenda(p);
    if (cfg.cozinha.ativo && cfg.cozinha.imprimir_automatico) imprimirCupom(setCupom, vendaDoPedido(p), 'cozinha', (m) => toast.sucesso(m));
  }

  if (lojas.length === 0) {
    return (
      <div className="page">
        <h2>Pedidos</h2>
        <div className="card"><p className="muted">Nenhuma loja usa pedidos ainda. Em <b>Lojas &amp; PDVs</b>, marque “Usar pedidos” na loja (por exemplo, a lanchonete).</p></div>
      </div>
    );
  }

  const noQuadro = (s) => filtrados.filter((p) => p.status === s);

  function Card({ p }) {
    const a = textoAcao(p);
    const tarde = atrasado(p);
    return (
      <div className={`ped-card ${tarde ? 'late' : ''}`} onClick={() => abrirDetalhe(p.id)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') abrirDetalhe(p.id); }}>
        <div className="ped-r1">
          <span className="ped-num">#{p.numero}</span>
          <span className="ped-tag">{NOME_ORIGEM[p.origem]}</span>
          <span className={`ped-tm ${tarde ? 'late' : ''}`}>{minutos(p)} min</span>
        </div>
        <div className="ped-cli">{p.cliente_nome || 'Cliente'}</div>
        <div className="ped-its">{p.itens.map((i) => `${qtd(i.quantidade)}× ${i.product_nome}`).join(' · ')}</div>
        <div className="ped-r3">
          <span className="ped-tag">{p.tipo === 'entrega' ? '🛵 Entrega' : p.tipo === 'mesa' ? `🍽 ${p.endereco || 'Mesa'}` : '🛍 Retirada'}</span>
          <span className={`ped-pill ${p.pago ? 'ok' : 'warn'}`}>{p.pago ? 'Pago' : 'Receber'}</span>
          {aberto(p) && <span className="ped-tag">🔒 Reservado</span>}
          <span className="ped-tot">{brl(p.total)}</span>
        </div>
        {p.entregador_nome && p.status === 'saiu_entrega' && <div className="ped-its" style={{ marginTop: 6 }}>Entregador: <b>{p.entregador_nome}</b></div>}
        {a && aberto(p) && (
          <div className="ped-act" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => avancar(p)}>{a}</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="ped-head">
        <h2>Pedidos</h2>
        {lojas.length > 1 && (
          <select value={lojaId} onChange={(e) => setLojaId(e.target.value)} aria-label="Loja" style={{ width: 'auto' }}>
            {lojas.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
          </select>
        )}
        <button type="button" className="btn-link" onClick={() => setEntregadoresAberto(true)}>Entregadores</button>
        <button type="button" className="btn-primario" onClick={() => setNovoAberto(true)}>+ Novo pedido</button>
      </div>

      <div className="ped-kpis">
        <div className={`ped-kpi hero ${conta('novo') ? 'pulse' : ''}`}><small>Novos</small><b>{conta('novo')}</b></div>
        <div className="ped-kpi"><small>Em preparo</small><b>{conta('em_preparo')}</b></div>
        <div className="ped-kpi"><small>Prontos p/ retirar/entregar</small><b>{conta('pronto')}</b></div>
        <div className="ped-kpi"><small>Em entrega</small><b>{conta('saiu_entrega')}</b></div>
        <div className="ped-kpi"><small>Finalizados hoje</small><b>{conta('finalizado')}</b>{atrasados > 0 && <span className="ped-pill warn" style={{ marginLeft: 6 }}>{atrasados} atrasado{atrasados > 1 ? 's' : ''}</span>}</div>
      </div>

      <div className="ped-bar">
        {ORIGENS_FILTRO.map(([id, nome]) => (
          <button key={id} type="button" className={`ped-chip ${origem === id ? 'on' : ''}`} onClick={() => setOrigem(id)}>{nome}</button>
        ))}
        <input className="ped-busca" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nº, cliente ou telefone" aria-label="Buscar pedido" />
        <div className="ped-seg">
          <button type="button" className={visao === 'quadro' ? 'on' : ''} onClick={() => setVisao('quadro')}>Quadro</button>
          <button type="button" className={visao === 'lista' ? 'on' : ''} onClick={() => setVisao('lista')}>Lista</button>
        </div>
      </div>

      {visao === 'quadro' ? (
        <div className="ped-board">
          {COLUNAS.map(([status, nome, ponto]) => {
            const lista = noQuadro(status);
            return (
              <div className="ped-col" key={status}>
                <h4><span className={`ped-dot ${ponto}`} />{nome}<span className="ped-cnt">{lista.length}</span></h4>
                {lista.map((p) => <Card key={p.id} p={p} />)}
                {lista.length === 0 && <div className="ped-vazio">Nenhum pedido</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card">
          <div className="tabela-wrap">
            <table>
              <thead><tr><th>Nº</th><th>Origem</th><th>Cliente</th><th>Tipo</th><th>Status</th><th>Pagamento</th><th>Tempo</th><th className="num">Total</th></tr></thead>
              <tbody>
                {filtrados.map((p) => (
                  <tr key={p.id} className="clicavel" onClick={() => abrirDetalhe(p.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') abrirDetalhe(p.id); }}>
                    <td><b>#{p.numero}</b></td>
                    <td><span className="ped-tag">{NOME_ORIGEM[p.origem]}</span></td>
                    <td>{p.cliente_nome || 'Cliente'}</td>
                    <td>{p.tipo === 'entrega' ? 'Entrega' : p.tipo === 'mesa' ? (p.endereco || 'Mesa') : 'Retirada'}</td>
                    <td>{NOME_STATUS[p.status]}</td>
                    <td><span className={`ped-pill ${p.pago ? 'ok' : 'warn'}`}>{p.pago ? 'Pago' : 'Receber'}</span></td>
                    <td style={{ color: atrasado(p) ? 'var(--warn)' : 'var(--muted-2)' }}>{minutos(p)} min</td>
                    <td className="num"><b>{brl(p.total)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtrados.length === 0 && <div className="ped-vazio">Nenhum pedido</div>}
        </div>
      )}

      <p className="form-hint" style={{ marginTop: 14 }}>
        O estoque é <b>reservado ao criar o pedido</b> (disponível = saldo − reservado). Cancelar libera a reserva; finalizar converte a reserva em baixa definitiva e entra no caixa. A tela atualiza sozinha a cada 15 segundos.
      </p>

      {aberta && detalhe && detalhe.id === aberta && (
        <Gaveta pedido={detalhe} entregadores={entregadores.filter((e) => e.ativo || e.id === detalhe.entregador_id)} agoraMin={minutos}
          onClose={() => { setAberta(null); setDetalhe(null); }}
          onAvancar={() => avancar(detalhe)} onCancelar={() => setCancelar(detalhe)} onDestino={() => setDestino(detalhe)} onImprimir={() => imprimir(detalhe.id)}
          onEntregador={(id) => executar(api.put(`/orders/${detalhe.id}/entregador`, { entregador_id: id || null }))}
          pedidoLista={pedidos.find((p) => p.id === aberta)} />
      )}

      {novoAberto && (
        <PedidoForm lojaId={lojaId} origemInicial="telefone" permitirBusca mostrarOrigem titulo="Novo pedido" onClose={() => setNovoAberto(false)} onCriado={aoCriar} />
      )}

      {receber && <ReceberModal pedido={receber} onClose={() => setReceber(null)} onConfirmar={(dados) => { const p = receber; setReceber(null); avancar(p, dados); }} />}
      {destino && <DestinoModal pedido={destino} onClose={() => setDestino(null)} onConfirmar={async (dados) => {
        const p = destino;
        const ok = await executar(api.put(`/orders/${p.id}/destino`, dados), (r) => `Pedido #${r.numero} agora é ${r.tipo === 'entrega' ? 'entrega' : r.tipo === 'mesa' ? r.endereco : 'retirada'}`);
        if (ok) setDestino(null);
      }} />}
      {cancelar && <CancelarModal pedido={cancelar} onClose={() => setCancelar(null)} onConfirmar={async (motivo) => {
        const p = cancelar;
        setCancelar(null);
        const ok = await executar(api.post(`/orders/${p.id}/cancel`, { motivo }), (r) => `Pedido #${r.numero} cancelado · reserva liberada, estoque disponível novamente`);
        if (ok) { setAberta(null); setDetalhe(null); }
      }} />}
      {escolherEntregador && (
        <EntregadorModal pedido={escolherEntregador} entregadores={entregadores.filter((e) => e.ativo)} onClose={() => setEscolherEntregador(null)}
          onConfirmar={(id) => { const p = escolherEntregador; setEscolherEntregador(null); avancar(p, { entregador_id: id }); }}
          onGerenciar={() => { setEscolherEntregador(null); setEntregadoresAberto(true); }} />
      )}
      {entregadoresAberto && <EntregadoresModal lista={entregadores} onClose={() => setEntregadoresAberto(false)} onMudou={recarregarEntregadores} />}
      {cupom && <Cupom venda={cupom} />}
    </div>
  );
}

// ---------- gaveta de detalhe ----------
function Gaveta({ pedido: p, entregadores, agoraMin, pedidoLista, onClose, onAvancar, onCancelar, onDestino, onImprimir, onEntregador }) {
  const entrega = p.tipo === 'entrega';
  const fluxo = entrega ? COLUNAS : COLUNAS.filter(([s]) => s !== 'saiu_entrega');
  const idx = fluxo.findIndex(([s]) => s === p.status);
  const quando = (status) => { const l = p.log.find((x) => x.para === status); return l ? dataHora(l.criado_em).slice(-5) : ''; };
  const a = textoAcao(p);
  const minutosEtapa = pedidoLista ? agoraMin(pedidoLista) : p.minutos_etapa;
  const NOME_PAG = { dinheiro: 'Dinheiro', cartao: 'Cartão', cartao_debito: 'Cartão-Débito', cartao_credito: 'Cartão-Crédito', pix: 'Pix' };
  const pagLabel = p.pago ? `${NOME_PAG[p.forma_pagamento_prevista] || 'Pix'} (já pago)` : `Pagar ${NOME_PAG[p.forma_pagamento_prevista] || 'Dinheiro'} na retirada/entrega`;
  const subtotal = p.itens.reduce((s, i) => s + Number(i.subtotal), 0);
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="ped-ov" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="ped-drawer" role="dialog" aria-label={`Pedido ${p.numero}`}>
        <button type="button" className="modal-close" style={{ float: 'right' }} aria-label="Fechar" onClick={onClose}>×</button>
        <h3>Pedido #{p.numero} <span className="ped-tag">{NOME_ORIGEM[p.origem]}</span></h3>
        <div className="muted">{p.cliente_nome || 'Cliente'}{p.cliente_telefone ? ` · ${p.cliente_telefone}` : ''}{p.customer_id ? ' · 👤 cliente cadastrado' : ''}</div>
        <div className="muted" style={{ marginTop: 4 }}>{entrega ? `🛵 ${p.endereco}` : p.tipo === 'mesa' ? `🍽 ${p.endereco || 'Mesa'}` : '🛍 Retirada no balcão'}</div>
        {p.observacao && <div className="ped-nota"><b>Obs.:</b> {p.observacao}</div>}

        {p.status === 'cancelado' ? (
          <div className="ped-nota" style={{ borderColor: 'var(--err)' }}><b>Pedido cancelado</b>{p.motivo_cancelamento ? ` · ${p.motivo_cancelamento}` : ''}</div>
        ) : (
          <div className="ped-sec"><span className="ped-rotulo">Andamento</span>
            <ul className="ped-tl">
              {fluxo.map(([s, nome], i) => (
                <li key={s} className={i < idx ? 'done' : i === idx ? 'cur' : ''}>
                  <span className="ped-dot" />{s === 'finalizado' && !entrega ? 'Entregue ao cliente' : nome}
                  <small>{i === idx ? (s === 'finalizado' ? quando(s) : `há ${minutosEtapa} min`) : i < idx ? quando(s) : ''}</small>
                </li>
              ))}
            </ul>
          </div>
        )}

        {entrega && ['pronto', 'saiu_entrega'].includes(p.status) && (
          <Field label="Entregador">
            <select value={p.entregador_id || ''} onChange={(e) => onEntregador(e.target.value)}>
              <option value="">Escolha...</option>
              {entregadores.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
            </select>
          </Field>
        )}
        {entrega && p.status === 'finalizado' && p.entregador_nome && <div className="muted" style={{ marginTop: 8 }}>Entregador: <b>{p.entregador_nome}</b></div>}

        <div className="ped-sec"><span className="ped-rotulo">Itens</span>
          {p.itens.map((i) => (
            <div key={i.id}>
              <div className="ped-linha"><span>{qtd(i.quantidade, i.unidade)}× {i.product_nome}</span><span>{brl(i.subtotal)}</span></div>
              {i.observacao && <div className="ped-item-obsv">» {i.observacao}</div>}
            </div>
          ))}
          {Number(p.taxa_entrega) > 0 && <div className="ped-linha"><span>Taxa de entrega</span><span>{brl(p.taxa_entrega)}</span></div>}
          <div className="ped-linha ped-total"><span>Total</span><b>{brl(Number(p.total) || subtotal + Number(p.taxa_entrega))}</b></div>
          <div className="ped-linha"><span>Estoque</span><span className="ped-tag">{p.status === 'finalizado' ? 'Baixa definitiva' : p.status === 'cancelado' ? 'Reserva liberada' : '🔒 Reservado até finalizar'}</span></div>
          <div className="ped-linha"><span>{pagLabel}</span><span className={`ped-pill ${p.pago ? 'ok' : 'warn'}`}>{p.pago ? 'Pago' : 'A receber'}</span></div>
        </div>

        <div className="ped-botoes">
          {a && aberto(p) && <button type="button" className="btn-primario" style={{ flex: 1 }} onClick={onAvancar}>{a}</button>}
          <button type="button" onClick={onImprimir}>🖨 Imprimir comanda</button>
          {aberto(p) && p.status !== 'saiu_entrega' && <button type="button" onClick={onDestino}>Alterar destino</button>}
          {aberto(p) && <button type="button" className="perigo" onClick={onCancelar}>Cancelar</button>}
        </div>
      </aside>
    </div>
  );
}

// ---------- modais ----------
function ReceberModal({ pedido, onClose, onConfirmar }) {
  const total = Number(pedido.total);
  const [forma, setForma] = useState(['cartao_credito', 'cartao_debito', 'pix'].includes(pedido.forma_pagamento_prevista) ? pedido.forma_pagamento_prevista : pedido.forma_pagamento_prevista === 'cartao' ? 'cartao_credito' : 'dinheiro');
  const [recebido, setRecebido] = useState('');
  const valor = parseNumero(recebido);
  const troco = forma === 'dinheiro' && valor >= total ? valor - total : 0;
  const ok = forma !== 'dinheiro' || valor >= total;
  return (
    <Modal titulo={`Receber e finalizar · pedido #${pedido.numero}`} subtitulo={`Total ${brl(total)} — o valor entra no caixa agora`} onClose={onClose}>
      <form className="form-stack" onSubmit={(e) => { e.preventDefault(); if (ok) onConfirmar({ forma_pagamento: forma, valor_recebido: forma === 'dinheiro' ? valor : undefined }); }}>
        <Field label="Forma de pagamento">
          <select value={forma} onChange={(e) => setForma(e.target.value)} autoFocus>
            <option value="dinheiro">Dinheiro</option>
            <option value="cartao_credito">Cartão de crédito</option>
            <option value="cartao_debito">Cartão de débito</option>
            <option value="pix">Pix</option>
          </select>
        </Field>
        {forma === 'dinheiro' && (
          <>
            <Field label="Valor recebido (R$)"><input inputMode="decimal" value={recebido} onChange={(e) => setRecebido(e.target.value)} placeholder="0,00" /></Field>
            {valor >= total && <div className="ped-linha ped-total"><span>Troco</span><b>{brl(troco)}</b></div>}
          </>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Voltar</button>
          <button type="submit" disabled={!ok}>Receber e finalizar</button>
        </div>
      </form>
    </Modal>
  );
}

function DestinoModal({ pedido, onClose, onConfirmar }) {
  const [tipo, setTipo] = useState(pedido.tipo);
  const [endereco, setEndereco] = useState(pedido.tipo === 'entrega' ? pedido.endereco : '');
  const [mesa, setMesa] = useState(pedido.tipo === 'mesa' ? String(pedido.endereco || '').replace(/^mesa\s*/i, '') : '');
  const [taxaTxt, setTaxaTxt] = useState(Number(pedido.taxa_entrega) > 0 ? String(Number(pedido.taxa_entrega)).replace('.', ',') : '5,00');
  const taxa = tipo === 'entrega' ? Math.max(0, parseNumero(taxaTxt) || 0) : 0;
  const subtotal = pedido.itens.reduce((s, i) => s + Number(i.subtotal), 0);
  const ok = tipo === 'retirada' || (tipo === 'entrega' && endereco.trim().length >= 3) || (tipo === 'mesa' && mesa.trim().length >= 1);
  function enviar(e) {
    e.preventDefault();
    if (!ok) return;
    onConfirmar({ tipo, endereco: tipo === 'mesa' ? `Mesa ${mesa.trim()}` : endereco, taxa_entrega: taxa });
  }
  return (
    <Modal titulo={`Alterar destino · pedido #${pedido.numero}`} subtitulo="O cliente mudou de ideia? Escolha o novo destino." onClose={onClose}>
      <form className="form-stack" onSubmit={enviar}>
        <div className="ped-seg2">
          <button type="button" className={tipo === 'retirada' ? 'on' : ''} onClick={() => setTipo('retirada')}>🛍 Retirada</button>
          <button type="button" className={tipo === 'entrega' ? 'on' : ''} onClick={() => setTipo('entrega')}>🛵 Entrega</button>
          <button type="button" className={tipo === 'mesa' ? 'on' : ''} onClick={() => setTipo('mesa')}>🍽 Mesa</button>
        </div>
        {tipo === 'entrega' && (
          <div className="form-grid">
            <Field label="Endereço"><input autoFocus value={endereco} onChange={(e) => setEndereco(e.target.value)} placeholder="Rua, nº, bairro" /></Field>
            <Field label="Taxa de entrega (R$)"><input value={taxaTxt} onChange={(e) => setTaxaTxt(e.target.value)} inputMode="decimal" /></Field>
          </div>
        )}
        {tipo === 'mesa' && <Field label="Mesa"><input autoFocus value={mesa} onChange={(e) => setMesa(e.target.value)} maxLength={30} placeholder="Número ou nome da mesa" /></Field>}
        <div className="ped-linha ped-total"><span>Novo total</span><b>{brl(subtotal + taxa)}</b></div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Voltar</button>
          <button type="submit" disabled={!ok}>Alterar destino</button>
        </div>
      </form>
    </Modal>
  );
}

function CancelarModal({ pedido, onClose, onConfirmar }) {
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo={`Cancelar pedido #${pedido.numero}?`} subtitulo="A reserva do estoque é liberada na hora." onClose={onClose}>
      <form className="form-stack" onSubmit={(e) => { e.preventDefault(); if (motivo.trim().length >= 3) onConfirmar(motivo.trim()); }}>
        <Field label="Motivo do cancelamento *"><input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: cliente desistiu" /></Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Voltar</button>
          <button type="submit" className="perigo" disabled={motivo.trim().length < 3}>Cancelar pedido</button>
        </div>
      </form>
    </Modal>
  );
}

function EntregadorModal({ pedido, entregadores, onClose, onConfirmar, onGerenciar }) {
  const [id, setId] = useState(entregadores[0] ? entregadores[0].id : '');
  return (
    <Modal titulo={`Quem vai entregar o pedido #${pedido.numero}?`} onClose={onClose}>
      <div className="form-stack">
        {entregadores.length === 0 ? (
          <p className="muted">Nenhum entregador cadastrado. <button type="button" className="btn-link" onClick={onGerenciar}>Cadastrar entregadores</button></p>
        ) : (
          <Field label="Entregador"><select value={id} onChange={(e) => setId(e.target.value)} autoFocus>{entregadores.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}</select></Field>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Voltar</button>
          <button type="button" disabled={!id} onClick={() => onConfirmar(id)}>Saiu p/ entrega</button>
        </div>
      </div>
    </Modal>
  );
}

function EntregadoresModal({ lista, onClose, onMudou }) {
  const toast = useToast();
  const [nome, setNome] = useState('');
  async function adicionar(e) {
    e.preventDefault();
    try { await api.post('/couriers', { nome }); setNome(''); onMudou(); } catch (err) { toast.erro(err); }
  }
  async function alternar(c) {
    try { await api.patch(`/couriers/${c.id}`, { ativo: !c.ativo }); onMudou(); } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo="Entregadores" subtitulo="Quem faz as entregas dos pedidos" onClose={onClose}>
      <div className="form-stack">
        <form onSubmit={adicionar} className="form-grid">
          <Field label="Novo entregador"><input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome" autoFocus /></Field>
          <button type="submit" className="btn-primario" disabled={nome.trim().length < 2}>Adicionar</button>
        </form>
        <ul className="lista-simples">
          {lista.map((c) => (
            <li key={c.id} style={{ opacity: c.ativo ? 1 : 0.55 }}>
              <span>{c.nome}{!c.ativo && <span className="badge-inativo"> inativo</span>}</span>
              <button type="button" className={`btn-link ${c.ativo ? 'perigo' : ''}`} onClick={() => alternar(c)}>{c.ativo ? 'Desativar' : 'Reativar'}</button>
            </li>
          ))}
          {lista.length === 0 && <li className="muted">Nenhum entregador cadastrado.</li>}
        </ul>
        <div className="modal-actions"><button type="button" onClick={onClose}>Fechar</button></div>
      </div>
    </Modal>
  );
}

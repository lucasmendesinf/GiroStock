import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field, Modal, Vazio } from '../../components/ui.jsx';
import { brl, parseNumero, qtd } from '../../utils/format';
import { baixarCsv, numeroCsv } from '../../utils/csv';

// Estoque do evento (o setor e um estoque temporario): carga e reforco do deposito, perdas durante o evento, contagem do que
// sobrou no fim (a diferenca vira quebra) com devolucao ao deposito, e o relatorio de quebra (imprimir/PDF e CSV).
export default function EstoqueEvento({ evento, onMudou }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [modal, setModal] = useState(null); // 'carga' | 'perda' | 'contagem'
  const carregar = useCallback(() => api.get(`/eventos/${evento.id}/estoque`).then(setD).catch((err) => toast.erro(err)), [evento.id, toast]);
  useEffect(() => { carregar(); }, [carregar]);
  if (!d) return <p className="muted">Carregando o estoque…</p>;

  const fechado = !!d.evento.estoque_fechado_em;
  const pode = {
    carga: !fechado && (evento.status === 'agendado' || evento.status === 'aberto'),
    perda: !fechado && (evento.status === 'aberto' || evento.status === 'encerrado'),
    contagem: !fechado && evento.status === 'encerrado',
  };
  const jaTemCarga = d.itens.some((i) => i.enviado > 0);
  const pronto = async (novo, msg) => { setD(novo); setModal(null); toast.sucesso(msg); onMudou && onMudou(); };

  function exportar() {
    baixarCsv(`estoque_evento_${evento.nome.replace(/\W+/g, '_').toLowerCase()}.csv`,
      ['Produto', 'Código', 'Enviado', 'Vendido', 'Perdas', 'Contado', 'Diferença', 'Devolvido', 'Quebra (qtd)', 'Quebra (R$)'],
      d.itens.map((i) => [i.nome, i.codigo_interno, numeroCsv(i.enviado), numeroCsv(i.vendido), numeroCsv(i.perdas), i.contado === null ? '' : numeroCsv(i.contado), i.diferenca === null ? '' : numeroCsv(i.diferenca), numeroCsv(i.devolvido), numeroCsv(i.quebra_total), numeroCsv(i.valor_quebra)]));
  }
  function imprimir() {
    const w = window.open('', '_blank', 'width=1000,height=900');
    if (!w) return toast.erro('Libere as janelas (pop-up) do navegador para imprimir');
    const esc = (t) => String(t === null || t === undefined ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const q = (v, u) => (v === null ? '—' : esc(qtd(v, u)));
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Estoque do evento</title><style>
      body{font:12px system-ui,sans-serif;margin:24px;color:#111} h1{font-size:19px;margin:0 0 2px} .sub{color:#555;margin-bottom:10px}
      table{width:100%;border-collapse:collapse;margin-top:10px} td,th{border-bottom:1px solid #ccc;padding:5px 4px;text-align:left} th{font-size:10px;text-transform:uppercase;color:#444}
      .n{text-align:right;white-space:nowrap} .neg{color:#b00020;font-weight:700} .tot td{font-weight:700;border-top:2px solid #333} .caixa{display:flex;gap:24px;margin:8px 0} .caixa div b{display:block;font-size:15px}
      @page{margin:12mm}</style></head><body>
      <h1>Estoque do evento: ${esc(evento.nome)}</h1>
      <div class="sub">${esc(new Date(evento.inicio).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }))} · ${esc(evento.location_nome)}${fechado ? ' · contagem feita' : ' · contagem ainda não feita'}</div>
      <div class="caixa"><div>Enviado (custo)<b>${brl(d.totais.enviado_custo)}</b></div><div>Vendido (custo)<b>${brl(d.totais.vendido_custo)}</b></div><div>Devolvido (custo)<b>${brl(d.totais.devolvido_custo)}</b></div><div>Quebra/perdas (custo)<b>${brl(d.totais.valor_quebra)}</b></div></div>
      <table><tr><th>Produto</th><th class="n">Enviado</th><th class="n">Vendido</th><th class="n">Perdas</th><th class="n">Contado</th><th class="n">Diferença</th><th class="n">Devolvido</th><th class="n">Quebra</th><th class="n">Quebra R$</th></tr>
      ${d.itens.map((i) => `<tr><td><b>${esc(i.nome)}</b><br><small>${esc(i.codigo_interno)}</small></td><td class="n">${q(i.enviado, i.unidade)}</td><td class="n">${q(i.vendido, i.unidade)}</td><td class="n">${q(i.perdas, i.unidade)}</td><td class="n">${q(i.contado, i.unidade)}</td><td class="n ${i.diferenca < 0 ? 'neg' : ''}">${q(i.diferenca, i.unidade)}</td><td class="n">${q(i.devolvido, i.unidade)}</td><td class="n ${i.quebra_total > 0 ? 'neg' : ''}">${q(i.quebra_total, i.unidade)}</td><td class="n">${brl(i.valor_quebra)}</td></tr>`).join('')}
      <tr class="tot"><td colspan="8">Total da quebra/perdas a preço de custo</td><td class="n">${brl(d.totais.valor_quebra)}</td></tr></table>
      ${d.perdas_por_tipo.length ? `<p><b>Perdas por tipo:</b> ${d.perdas_por_tipo.map((p) => `${esc(p.nome)} ${brl(p.valor)}`).join(' · ')}</p>` : ''}
      <script>window.print()</script></body></html>`);
    w.document.close();
  }

  return (
    <div className="form-stack">
      <div className="ped-kpis ev-kpis">
        <div className="ped-kpi"><small>Enviado ao setor</small><b>{brl(d.totais.enviado_custo)}</b><span className="cl-sub">a preço de custo</span></div>
        <div className="ped-kpi"><small>Vendido</small><b>{brl(d.totais.vendido_custo)}</b><span className="cl-sub">a preço de custo</span></div>
        <div className="ped-kpi"><small>Devolvido ao depósito</small><b>{brl(d.totais.devolvido_custo)}</b></div>
        <div className="ped-kpi"><small>Quebra e perdas</small><b style={d.totais.valor_quebra > 0 ? { color: 'var(--err)' } : undefined}>{brl(d.totais.valor_quebra)}</b><span className="cl-sub">{fechado ? 'contagem feita' : 'até agora'}</span></div>
      </div>
      <div className="ev-acoes-estoque">
        {pode.carga && <button type="button" className="btn-primario" onClick={() => setModal('carga')}>{jaTemCarga ? 'Mandar reforço' : 'Enviar carga'}</button>}
        {pode.perda && <button type="button" onClick={() => setModal('perda')}>Lançar perda</button>}
        {pode.contagem && <button type="button" className="btn-primario" onClick={() => setModal('contagem')}>Fazer a contagem</button>}
        <span className="toolbar-espaco" />
        {d.itens.length > 0 && <button type="button" onClick={imprimir}>Imprimir / PDF</button>}
        {d.itens.length > 0 && <button type="button" onClick={exportar}>Exportar CSV</button>}
      </div>
      {evento.status === 'encerrado' && !fechado && <div className="es-erro" style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn)' }}>Evento encerrado: faça a contagem do que sobrou no setor para fechar o estoque e ver a quebra.</div>}
      {d.itens.length === 0 ? <Vazio>Nada enviado ao setor ainda. Use “Enviar carga” para levar os produtos do depósito para o evento.</Vazio> : (
        <div className="tabela-wrap">
          <table className="tabela-cartoes ev-estoque">
            <thead><tr><th>Produto</th><th className="num">Enviado</th><th className="num">Vendido</th><th className="num">Perdas</th><th className="num">{fechado ? 'Contado' : 'No setor'}</th><th className="num">Diferença</th><th className="num">Devolvido</th><th className="num">Quebra</th></tr></thead>
            <tbody>
              {d.itens.map((i) => (
                <tr key={i.product_id}>
                  <td><b>{i.nome}</b><div className="celula-sub">{i.codigo_interno}</div></td>
                  <td className="num">{qtd(i.enviado, i.unidade)}</td>
                  <td className="num">{qtd(i.vendido, i.unidade)}</td>
                  <td className="num">{i.perdas ? qtd(i.perdas, i.unidade) : '—'}</td>
                  <td className="num">{fechado ? (i.contado === null ? '—' : qtd(i.contado, i.unidade)) : qtd(i.saldo_setor, i.unidade)}</td>
                  <td className={`num ${i.diferenca < 0 ? 'ev-neg' : ''}`}>{i.diferenca === null ? '—' : `${i.diferenca > 0 ? '+' : ''}${qtd(i.diferenca, i.unidade)}`}</td>
                  <td className="num">{i.devolvido ? qtd(i.devolvido, i.unidade) : '—'}</td>
                  <td className={`num ${i.quebra_total > 0 ? 'ev-neg' : ''}`}>{i.quebra_total ? <><b>{qtd(i.quebra_total, i.unidade)}</b><div className="celula-sub">{brl(i.valor_quebra)}</div></> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.perdas_por_tipo.length > 0 && <p className="cl-sub" style={{ margin: 0 }}>Perdas por tipo: {d.perdas_por_tipo.map((p) => `${p.nome} ${brl(p.valor)}`).join(' · ')}</p>}

      {modal === 'carga' && <ModalCarga evento={evento} reforco={jaTemCarga} onClose={() => setModal(null)} onFeito={(n) => pronto(n, jaTemCarga ? 'Reforço enviado ao setor' : 'Carga enviada ao setor')} />}
      {modal === 'perda' && <ModalPerda evento={evento} itens={d.itens.filter((i) => i.saldo_setor > 0)} tipos={d.tipos_perda} onClose={() => setModal(null)} onFeito={(n) => pronto(n, 'Perda lançada')} />}
      {modal === 'contagem' && <ModalContagem evento={evento} itens={d.itens.filter((i) => i.saldo_setor !== 0 || i.enviado > 0)} onClose={() => setModal(null)} onFeito={(n) => pronto(n, 'Contagem feita: estoque do evento fechado')} />}
    </div>
  );
}

function ModalCarga({ evento, reforco, onClose, onFeito }) {
  const toast = useToast();
  const [produtos, setProdutos] = useState([]);
  const [busca, setBusca] = useState('');
  const [linhas, setLinhas] = useState({}); // product_id -> texto da quantidade
  const [salvando, setSalvando] = useState(false);
  useEffect(() => { api.get('/products').then((l) => setProdutos(l.filter((p) => p.ativo && !p.e_combo && !p.tem_ficha_tecnica))).catch((err) => toast.erro(err)); }, [toast]);
  const noDeposito = (p) => Number(((p.saldos_por_local || []).find((s) => s.location_id === evento.deposito_id) || {}).saldo || 0);
  const t = busca.trim().toLowerCase();
  const visiveis = useMemo(() => produtos.filter((p) => noDeposito(p) > 0 || linhas[p.id]).filter((p) => !t || p.nome.toLowerCase().includes(t) || p.barcode.includes(t)), [produtos, t, linhas]); // eslint-disable-line react-hooks/exhaustive-deps
  const escolhidos = Object.entries(linhas).filter(([, v]) => String(v).trim() && parseNumero(v) > 0);

  async function enviar() {
    if (!escolhidos.length) return toast.erro('Informe a quantidade de ao menos um produto');
    setSalvando(true);
    try { onFeito(await api.post(`/eventos/${evento.id}/carga`, { itens: escolhidos.map(([product_id, v]) => ({ product_id, quantidade: parseNumero(v) })) })); } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  if (!evento.deposito_id) return <Modal titulo="Enviar carga" onClose={onClose}><p>Informe o <b>depósito</b> no cadastro do evento (Editar) para enviar a carga.</p></Modal>;
  return (
    <Modal titulo={reforco ? 'Mandar reforço' : 'Enviar carga para o evento'} subtitulo={`Do depósito ${evento.deposito_nome} para o setor ${evento.location_nome}`} onClose={onClose} largura="extra">
      <div className="form-stack">
        <input className="ev-busca" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Pesquisar produto" aria-label="Pesquisar produto" autoFocus />
        <div className="tabela-wrap" style={{ maxHeight: 380, overflow: 'auto' }}>
          <table className="tabela-cartoes">
            <thead><tr><th>Produto</th><th className="num">No depósito</th><th className="num">Enviar</th></tr></thead>
            <tbody>
              {visiveis.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.nome}</b><div className="celula-sub">{p.codigo_interno}</div></td>
                  <td className="num">{qtd(noDeposito(p), p.unidade)}</td>
                  <td className="num"><input inputMode="decimal" value={linhas[p.id] || ''} onChange={(e) => setLinhas({ ...linhas, [p.id]: e.target.value })} placeholder="0" style={{ maxWidth: 90 }} aria-label={`Quantidade de ${p.nome}`} /></td>
                </tr>
              ))}
              {visiveis.length === 0 && <tr><td colSpan={3} className="muted">Nenhum produto com saldo no depósito.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn-primario" disabled={salvando} onClick={enviar}>{salvando ? 'Enviando...' : `Enviar ${escolhidos.length} produto(s)`}</button>
        </div>
      </div>
    </Modal>
  );
}

function ModalPerda({ evento, itens, tipos, onClose, onFeito }) {
  const toast = useToast();
  const [f, setF] = useState({ product_id: '', quantidade: '', tipo: 'quebra', observacao: '' });
  const [salvando, setSalvando] = useState(false);
  async function salvar(e) {
    e.preventDefault();
    if (!f.product_id || !(parseNumero(f.quantidade) > 0)) return toast.erro('Escolha o produto e a quantidade');
    setSalvando(true);
    try { onFeito(await api.post(`/eventos/${evento.id}/perdas`, { ...f, quantidade: parseNumero(f.quantidade) })); } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  return (
    <Modal titulo="Lançar perda" subtitulo="Sai do estoque do setor e entra no relatório de quebra do evento." onClose={onClose}>
      <form className="form-stack" onSubmit={salvar}>
        <Field label="Produto">
          <select value={f.product_id} onChange={(e) => setF({ ...f, product_id: e.target.value })} autoFocus>
            <option value="">Escolha...</option>
            {itens.map((i) => <option key={i.product_id} value={i.product_id}>{i.nome} (no setor: {qtd(i.saldo_setor, i.unidade)})</option>)}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Quantidade"><input inputMode="decimal" value={f.quantidade} onChange={(e) => setF({ ...f, quantidade: e.target.value })} /></Field>
          <Field label="Tipo">
            <select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}>{Object.entries(tipos).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
          </Field>
        </div>
        <Field label="Observação"><input value={f.observacao} onChange={(e) => setF({ ...f, observacao: e.target.value })} maxLength={200} placeholder="Ex.: garrafa quebrou no transporte" /></Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-primario" disabled={salvando}>Lançar perda</button>
        </div>
      </form>
    </Modal>
  );
}

function ModalContagem({ evento, itens, onClose, onFeito }) {
  const toast = useToast();
  const [cont, setCont] = useState({});
  const [devolver, setDevolver] = useState(!!evento.deposito_id);
  const [salvando, setSalvando] = useState(false);
  const falta = itens.filter((i) => !String(cont[i.product_id] ?? '').trim());
  const valor = (i) => (String(cont[i.product_id] ?? '').trim() ? parseNumero(cont[i.product_id]) : null);
  const totalQuebra = itens.reduce((s, i) => { const v = valor(i); return v === null ? s : s + Math.max(0, i.saldo_setor - v) * i.custo_unitario; }, 0);
  async function salvar() {
    if (falta.length) return toast.erro(`Falta contar: ${falta.slice(0, 3).map((i) => i.nome).join(', ')}${falta.length > 3 ? '…' : ''}`);
    setSalvando(true);
    try { onFeito(await api.post(`/eventos/${evento.id}/fechar-estoque`, { devolver, itens: itens.map((i) => ({ product_id: i.product_id, contado: valor(i) })) })); } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  return (
    <Modal titulo="Contagem do que sobrou" subtitulo={`Conte o que ficou no setor ${evento.location_nome}. A diferença para o sistema vira quebra (ou sobra).`} onClose={onClose} largura="extra">
      <div className="form-stack">
        <div className="tabela-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
          <table className="tabela-cartoes">
            <thead><tr><th>Produto</th><th className="num">Sistema</th><th className="num">Contado</th><th className="num">Diferença</th></tr></thead>
            <tbody>
              {itens.map((i) => {
                const v = valor(i);
                const dif = v === null ? null : Number((v - i.saldo_setor).toFixed(3));
                return (
                  <tr key={i.product_id}>
                    <td><b>{i.nome}</b><div className="celula-sub">enviado {qtd(i.enviado, i.unidade)} · vendido {qtd(i.vendido, i.unidade)}</div></td>
                    <td className="num">{qtd(i.saldo_setor, i.unidade)}</td>
                    <td className="num"><input inputMode="decimal" value={cont[i.product_id] ?? ''} onChange={(e) => setCont({ ...cont, [i.product_id]: e.target.value })} style={{ maxWidth: 90 }} aria-label={`Contado de ${i.nome}`} /></td>
                    <td className={`num ${dif < 0 ? 'ev-neg' : ''}`}>{dif === null ? '—' : `${dif > 0 ? '+' : ''}${qtd(dif, i.unidade)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <label className="check"><input type="checkbox" checked={devolver} disabled={!evento.deposito_id} onChange={(e) => setDevolver(e.target.checked)} /> Devolver o que sobrou para o depósito{evento.deposito_nome ? ` (${evento.deposito_nome})` : ' (sem depósito no cadastro)'}</label>
        <p className="cl-sub" style={{ margin: 0 }}>Quebra pela contagem até agora: <b>{brl(totalQuebra)}</b> a preço de custo. Depois de confirmar, o estoque do evento fica fechado.</p>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn-primario" disabled={salvando} onClick={salvar}>{salvando ? 'Fechando...' : 'Confirmar contagem'}</button>
        </div>
      </div>
    </Modal>
  );
}

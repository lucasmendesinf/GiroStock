import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { brl, dataHora, parseNumero, qtd, UNIDADES_INTEIRAS } from '../../utils/format';
import { lembrarLoja, lojaPadrao, stepDaUnidade } from './comum.jsx';
import { minimoNaLoja, saldoNaLoja, situacaoNaLoja, situacaoProduto, totalDoProduto } from './estoque.js';

const ABAS = [
  ['saldos', 'Saldo por loja'],
  ['entrada', 'Entrada'],
  ['transferencia', 'Transferência'],
  ['saida', 'Saída'],
  ['balanco', 'Balanço'],
  ['hist', 'Histórico'],
];
const MOTIVOS_SAIDA = ['Perda / quebra', 'Validade vencida', 'Uso interno / consumo', 'Brinde / bonificação', 'Outro'];
const NOMES_TIPO = { entrada: 'Entrada', saida: 'Saída', transferencia: 'Transferência', balanco: 'Balanço' };

// Modal "Tratar estoque" de um produto comum (sem ficha tecnica): saldo por loja, entrada,
// transferencia, saida, balanco e historico. Produto composto nao tem estoque proprio.
export default function EstoqueProduto({ produto, locations, suppliers, reload, onClose }) {
  const { user } = useAuth();
  const [aba, setAba] = useState('saldos');
  const [presel, setPresel] = useState('');
  const [versao, setVersao] = useState(0);
  const locaisAtivos = locations.filter((l) => l.ativo);
  const st = situacaoProduto(produto, new Map());
  const total = totalDoProduto(produto);

  const concluir = useCallback(async () => {
    await reload();
    setVersao((v) => v + 1);
  }, [reload]);

  function irPara(novaAba, lojaId) { setPresel(lojaId || ''); setAba(novaAba); }

  const props = { produto, locaisAtivos, user, presel, suppliers, concluir, irPara };

  return (
    <Modal titulo={produto.nome} subtitulo={`Tratar estoque · ${produto.codigo_interno} · EAN ${produto.barcode} · unidade ${produto.unidade}`}
      onClose={onClose} largura="extra">
      <div className="es-kpis">
        <div className="es-kpi"><small>Estoque total</small><b>{qtd(total, produto.unidade)} {produto.unidade}</b></div>
        <div className="es-kpi"><small>Custo médio</small><b>{brl(produto.preco_custo)}</b></div>
        <div className="es-kpi"><small>Valor em estoque</small><b>{brl(total * Number(produto.preco_custo))}</b></div>
        <div className="es-kpi"><small>Situação</small><b><span className={`es-pill ${st.cls}`} style={{ fontSize: 13 }}>{st.txt}</span></b></div>
      </div>

      <div className="es-tabs" role="tablist">
        {ABAS.map(([id, nome]) => (
          <button key={id} type="button" role="tab" aria-selected={aba === id} className={`es-tab ${aba === id ? 'on' : ''}`} onClick={() => irPara(id)}>{nome}</button>
        ))}
      </div>

      <div key={`${aba}-${versao}`}>
        {aba === 'saldos' && <TelaSaldos {...props} />}
        {aba === 'entrada' && <TelaEntrada {...props} />}
        {aba === 'transferencia' && <TelaTransferencia {...props} />}
        {aba === 'saida' && <TelaSaida {...props} />}
        {aba === 'balanco' && <TelaBalanco {...props} />}
        {aba === 'hist' && <TelaHistorico produto={produto} versao={versao} />}
      </div>
    </Modal>
  );
}

const opcaoLoja = (produto, l) => <option key={l.id} value={l.id}>{l.nome} (saldo {qtd(saldoNaLoja(produto, l.id), produto.unidade)})</option>;
const lojaComSaldo = (produto, locais) => (locais.find((l) => saldoNaLoja(produto, l.id) > 0) || locais[0] || {}).id || '';

function TelaSaldos({ produto, locaisAtivos, irPara, concluir }) {
  const toast = useToast();
  const [minimos, setMinimos] = useState({});

  async function salvarMinimo(l) {
    const texto = minimos[l.id];
    if (texto === undefined) return;
    const n = parseNumero(texto === '' ? '0' : texto);
    if (!(n >= 0)) { toast.erro('Estoque mínimo inválido.'); return; }
    if (n === minimoNaLoja(produto, l.id)) { setMinimos((m) => { const c = { ...m }; delete c[l.id]; return c; }); return; }
    try {
      await api.put(`/products/${produto.id}/minimum`, { location_id: l.id, estoque_minimo: n });
      toast.sucesso(`Estoque mínimo de ${l.nome} salvo.`);
      setMinimos((m) => { const c = { ...m }; delete c[l.id]; return c; });
      await concluir();
    } catch (err) { toast.erro(err); }
  }

  return (
    <>
      <div className="es-titulo">Saldo e estoque mínimo em cada loja</div>
      <div className="card">
        <div className="tabela-wrap">
          <table className="compacta">
            <thead><tr><th>Loja</th><th className="num">Saldo</th><th className="num">Mínimo</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {locaisAtivos.map((l) => {
                const saldo = saldoNaLoja(produto, l.id);
                const sit = situacaoNaLoja(produto, l.id);
                return (
                  <tr key={l.id}>
                    <td><b>{l.nome}</b></td>
                    <td className="num"><b>{qtd(saldo, produto.unidade)}</b></td>
                    <td className="num">
                      <input className="es-min" inputMode="decimal" aria-label={`Estoque mínimo em ${l.nome}`}
                        value={minimos[l.id] ?? qtd(minimoNaLoja(produto, l.id), produto.unidade)}
                        onChange={(e) => setMinimos({ ...minimos, [l.id]: e.target.value })}
                        onBlur={() => salvarMinimo(l)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
                    </td>
                    <td><span className={`es-pill ${sit.cls}`}>{sit.txt}</span></td>
                    <td>
                      <div className="es-acoes">
                        <button type="button" className="es-btn-ghost" onClick={() => irPara('entrada', l.id)}>+ Entrada</button>
                        <button type="button" className="es-btn-ghost" disabled={saldo <= 0} onClick={() => irPara('transferencia', l.id)}>Transferir</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="es-dica">O mínimo gera o alerta de "estoque baixo" na tela Início e na lista de produtos.</div>
    </>
  );
}

function TelaEntrada({ produto, locaisAtivos, user, presel, suppliers, concluir }) {
  const toast = useToast();
  const un = produto.unidade;
  const [f, setF] = useState({ loja: presel || lojaPadrao(user, locaisAtivos), q: '', c: '', fornecedor: '', nf: '', obs: '' });
  const [salvando, setSalvando] = useState(false);
  const q = parseNumero(f.q);
  const c = f.c.trim() === '' ? null : parseNumero(f.c);
  const saldo = saldoNaLoja(produto, f.loja);
  const total = totalDoProduto(produto);
  const custoAtual = Number(produto.preco_custo);
  const precoVenda = Number(produto.preco_venda);

  let resumo = 'Informe a quantidade para ver como fica o saldo.';
  let erro = '';
  if (q > 0) {
    resumo = <>Saldo em <b>{(locaisAtivos.find((l) => l.id === f.loja) || {}).nome}</b>: {qtd(saldo, un)} → <b>{qtd(saldo + q, un)} {un}</b></>;
    if (c !== null && c > 0) {
      const novo = Number(((total * custoAtual + q * c) / (total + q)).toFixed(2));
      resumo = <>{resumo}<br />Custo médio: {brl(custoAtual)} → <b>{brl(novo)}</b> (média ponderada)</>;
      if (novo >= precoVenda) erro = `Entrada recusada: o custo médio ficaria maior ou igual ao preço de venda (${brl(precoVenda)}).`;
    }
    if (c !== null && !(c > 0)) erro = 'O custo unitário precisa ser maior que zero.';
    if (UNIDADES_INTEIRAS.includes(un) && !Number.isInteger(q)) erro = `Produtos em ${un} só aceitam quantidade inteira.`;
  }

  async function registrar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      const payload = { product_id: produto.id, tipo: 'entrada', quantidade: q, location_destino_id: f.loja, motivo: f.obs.trim() || 'Compra' };
      if (f.fornecedor) payload.supplier_id = f.fornecedor;
      if (c !== null) payload.custo_unitario = c;
      if (f.nf.trim()) payload.documento_fiscal = f.nf.trim();
      const r = await api.post('/stock-movements', payload);
      lembrarLoja(f.loja);
      toast.sucesso(r.preco_custo_atualizado ? `Entrada registrada. Novo custo médio: ${brl(r.preco_custo_atualizado)}.` : 'Entrada registrada.');
      await concluir();
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  return (
    <form className="es-form" onSubmit={registrar}>
      <Field label="Loja que recebe">
        <select value={f.loja} onChange={(e) => setF({ ...f, loja: e.target.value })}>{locaisAtivos.map((l) => opcaoLoja(produto, l))}</select>
      </Field>
      <Field label={`Quantidade (${un})`}>
        <input type="number" min="0" step={stepDaUnidade(un)} placeholder="0" autoFocus value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </Field>
      <Field label="Custo unitário desta compra (R$)">
        <input inputMode="decimal" placeholder={String(custoAtual.toFixed(2)).replace('.', ',')} value={f.c} onChange={(e) => setF({ ...f, c: e.target.value })} />
      </Field>
      <Field label="Fornecedor">
        <select value={f.fornecedor} onChange={(e) => setF({ ...f, fornecedor: e.target.value })}>
          <option value="">— não informar —</option>
          {suppliers.filter((s) => s.ativo).map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
        </select>
      </Field>
      <Field label="Nota fiscal"><input placeholder="Ex.: 4821" value={f.nf} onChange={(e) => setF({ ...f, nf: e.target.value })} /></Field>
      <Field label="Observação"><input placeholder="Compra, bonificação, devolução..." value={f.obs} onChange={(e) => setF({ ...f, obs: e.target.value })} /></Field>
      <div className="full es-resumo">{resumo}</div>
      {erro && <div className="full es-erro">{erro}</div>}
      <div className="full"><button type="submit" className="btn-primario" disabled={!(q > 0) || !!erro || salvando}>Registrar entrada</button></div>
    </form>
  );
}

function TelaTransferencia({ produto, locaisAtivos, user, presel, concluir }) {
  const toast = useToast();
  const un = produto.unidade;
  const origem0 = presel || (user.locationId && locaisAtivos.some((l) => l.id === user.locationId) ? user.locationId : lojaComSaldo(produto, locaisAtivos));
  const destino0 = (locaisAtivos.find((l) => l.id !== origem0) || {}).id || '';
  const [f, setF] = useState({ o: origem0, d: destino0, q: '', m: '' });
  const [salvando, setSalvando] = useState(false);
  const q = parseNumero(f.q);
  const so = saldoNaLoja(produto, f.o);
  const sd = saldoNaLoja(produto, f.d);
  const nome = (id) => (locaisAtivos.find((l) => l.id === id) || {}).nome;
  let erro = '';
  if (f.o === f.d) erro = 'Origem e destino precisam ser lojas diferentes.';
  else if (q > so) erro = `Saldo insuficiente em ${nome(f.o)} (disponível: ${qtd(so, un)}).`;
  else if (q > 0 && UNIDADES_INTEIRAS.includes(un) && !Number.isInteger(q)) erro = `Produtos em ${un} só aceitam quantidade inteira.`;
  const qv = q > 0 ? q : 0;

  async function transferir(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      await api.post('/stock-movements', { product_id: produto.id, tipo: 'transferencia', quantidade: q, location_origem_id: f.o, location_destino_id: f.d, motivo: f.m.trim() });
      toast.sucesso('Transferência registrada.');
      await concluir();
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  return (
    <form className="es-form" onSubmit={transferir}>
      <Field label="De (origem)"><select value={f.o} onChange={(e) => setF({ ...f, o: e.target.value })}>{locaisAtivos.map((l) => opcaoLoja(produto, l))}</select></Field>
      <Field label="Para (destino)"><select value={f.d} onChange={(e) => setF({ ...f, d: e.target.value })}>{locaisAtivos.map((l) => opcaoLoja(produto, l))}</select></Field>
      <Field label={`Quantidade (${un})`}><input type="number" min="0" step={stepDaUnidade(un)} placeholder="0" autoFocus value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
      <Field label="Motivo"><input placeholder="Ex.: reposição da lanchonete" value={f.m} onChange={(e) => setF({ ...f, m: e.target.value })} /></Field>
      <div className="full es-resumo">
        <b>{nome(f.o)}</b>: {qtd(so, un)} → <b>{qtd(so - qv, un)}</b> &nbsp;•&nbsp; <b>{nome(f.d)}</b>: {qtd(sd, un)} → <b>{qtd(sd + qv, un)}</b>
      </div>
      {erro && <div className="full es-erro">{erro}</div>}
      <div className="full"><button type="submit" className="btn-primario" disabled={!(q > 0) || !!erro || f.m.trim().length < 3 || salvando}>Transferir</button></div>
    </form>
  );
}

function TelaSaida({ produto, locaisAtivos, user, presel, concluir }) {
  const toast = useToast();
  const un = produto.unidade;
  const loja0 = presel || (user.locationId && locaisAtivos.some((l) => l.id === user.locationId) ? user.locationId : lojaComSaldo(produto, locaisAtivos));
  const [f, setF] = useState({ l: loja0, q: '', m: MOTIVOS_SAIDA[0], o: '' });
  const [salvando, setSalvando] = useState(false);
  const q = parseNumero(f.q);
  const s = saldoNaLoja(produto, f.l);
  const nome = (id) => (locaisAtivos.find((l) => l.id === id) || {}).nome;
  let erro = '';
  if (q > s) erro = `Saldo insuficiente em ${nome(f.l)} (disponível: ${qtd(s, un)}).`;
  else if (q > 0 && UNIDADES_INTEIRAS.includes(un) && !Number.isInteger(q)) erro = `Produtos em ${un} só aceitam quantidade inteira.`;

  async function registrar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      const motivo = [f.m, f.o.trim()].filter(Boolean).join(' — ');
      await api.post('/stock-movements', { product_id: produto.id, tipo: 'saida', quantidade: q, location_origem_id: f.l, motivo });
      toast.sucesso('Saída registrada.');
      await concluir();
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  return (
    <>
      <form className="es-form" onSubmit={registrar}>
        <Field label="Loja"><select value={f.l} onChange={(e) => setF({ ...f, l: e.target.value })}>{locaisAtivos.map((l) => opcaoLoja(produto, l))}</select></Field>
        <Field label={`Quantidade (${un})`}><input type="number" min="0" step={stepDaUnidade(un)} placeholder="0" autoFocus value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
        <Field label="Motivo"><select value={f.m} onChange={(e) => setF({ ...f, m: e.target.value })}>{MOTIVOS_SAIDA.map((m) => <option key={m}>{m}</option>)}</select></Field>
        <Field label="Observação"><input placeholder="Opcional" value={f.o} onChange={(e) => setF({ ...f, o: e.target.value })} /></Field>
        <div className="full es-resumo">
          Saldo em <b>{nome(f.l)}</b>: {qtd(s, un)} → <b>{qtd(s - (q > 0 ? q : 0), un)} {un}</b>
          {q > 0 && <> &nbsp;•&nbsp; custo da perda: <b>{brl(q * Number(produto.preco_custo))}</b></>}
        </div>
        {erro && <div className="full es-erro">{erro}</div>}
        <div className="full"><button type="submit" className="btn-primario" disabled={!(q > 0) || !!erro || salvando}>Registrar saída</button></div>
      </form>
      <div className="es-dica">Vendas pelo PDV baixam o estoque sozinhas — use esta tela só para perdas, vencimentos e consumo interno.</div>
    </>
  );
}

function TelaBalanco({ produto, locaisAtivos, user, presel, concluir }) {
  const toast = useToast();
  const un = produto.unidade;
  const loja0 = presel || (user.locationId && locaisAtivos.some((l) => l.id === user.locationId) ? user.locationId : lojaComSaldo(produto, locaisAtivos));
  const [f, setF] = useState({ l: loja0, q: '', m: '' });
  const [salvando, setSalvando] = useState(false);
  const motivoRef = useRef(null);
  const s = saldoNaLoja(produto, f.l);
  const vazio = f.q.trim() === '';
  const v = parseNumero(f.q);
  const dif = Number((v - s).toFixed(3));
  const nome = (id) => (locaisAtivos.find((l) => l.id === id) || {}).nome;
  let erro = '';
  if (!vazio && !(v >= 0)) erro = 'Informe uma contagem válida (0 ou mais).';
  else if (!vazio && UNIDADES_INTEIRAS.includes(un) && !Number.isInteger(v)) erro = `Produtos em ${un} só aceitam quantidade inteira.`;
  else if (!vazio && dif === 0) erro = 'A contagem é igual ao saldo atual: não há o que ajustar.';

  async function aplicar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      await api.post(`/products/${produto.id}/stock-adjustment`, { location_id: f.l, novo_saldo: v, motivo: f.m.trim() });
      toast.sucesso('Balanço aplicado.');
      await concluir();
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  return (
    <>
      <form className="es-form" onSubmit={aplicar}>
        <Field label="Loja"><select value={f.l} onChange={(e) => setF({ ...f, l: e.target.value })}>{locaisAtivos.map((l) => opcaoLoja(produto, l))}</select></Field>
        <Field label="Contagem física (novo saldo)"><input type="number" min="0" step={stepDaUnidade(un)} placeholder="0" autoFocus value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
        <Field label="Motivo" className="full"><input ref={motivoRef} placeholder="Ex.: inventário de setembro" value={f.m} onChange={(e) => setF({ ...f, m: e.target.value })} /></Field>
        <div className="full es-resumo">
          {vazio ? 'Informe a contagem física para ver a diferença.' : (
            <>Saldo em <b>{nome(f.l)}</b>: {qtd(s, un)} → <b>{qtd(v, un)} {un}</b> &nbsp;•&nbsp; diferença: <b>{dif >= 0 ? '+' : ''}{qtd(dif, un)}</b></>
          )}
        </div>
        {erro && <div className="full es-erro">{erro}</div>}
        <div className="full" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="submit" className="btn-primario" disabled={vazio || !!erro || f.m.trim().length < 3 || salvando}>Aplicar balanço</button>
          <button type="button" className="btn-link" onClick={() => { setF({ ...f, q: '0' }); setTimeout(() => motivoRef.current && motivoRef.current.focus(), 0); }}>Zerar estoque desta loja</button>
        </div>
      </form>
      <div className="es-dica">O balanço <b>substitui</b> o saldo pela contagem e guarda a diferença no histórico.</div>
    </>
  );
}

function TelaHistorico({ produto, versao }) {
  const toast = useToast();
  const [itens, setItens] = useState(null);

  useEffect(() => {
    let ativo = true;
    api.get(`/stock-movements?product_id=${produto.id}&limit=50`)
      .then((r) => { if (ativo) setItens(r.itens); })
      .catch((err) => toast.erro(err));
    return () => { ativo = false; };
  }, [produto.id, versao, toast]);

  if (itens === null) return <p className="muted">Carregando...</p>;
  const un = produto.unidade;
  return (
    <>
      <div className="es-titulo">Movimentações do produto</div>
      {itens.length === 0 && <div className="es-dica">Nenhuma movimentação ainda.</div>}
      {itens.map((m) => {
        const balanco = m.tipo === 'balanco';
        const lojas = balanco
          ? (m.location_destino_nome || m.location_origem_nome)
          : `${m.location_origem_nome ? `De ${m.location_origem_nome}` : ''}${m.location_origem_nome && m.location_destino_nome ? ' → ' : ''}${m.location_destino_nome ? `${m.location_origem_nome ? '' : 'Para '}${m.location_destino_nome}` : ''}`;
        const motivo = m.sale_numero ? `${m.tipo === 'entrada' ? 'Estorno da venda' : 'Venda'} nº ${m.sale_numero}`
          : balanco ? `${m.motivo} (de ${qtd(m.saldo_anterior, un)} para ${qtd(m.saldo_novo, un)})` : m.motivo;
        return (
          <div className="es-mov" key={m.id}>
            <div>
              <b className={`t-${m.tipo}`}>{NOMES_TIPO[m.tipo] || m.tipo}</b>
              {' · '}{balanco ? `contagem ${qtd(m.saldo_novo, un)} ${un}` : `${qtd(m.quantidade, un)} ${un}`}
              <div className="sub">{lojas} · {motivo}{m.usuario_nome ? ` · ${m.usuario_nome}` : ''}</div>
            </div>
            <div className="sub">{dataHora(m.criado_em)}</div>
          </div>
        );
      })}
    </>
  );
}

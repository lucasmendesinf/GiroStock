import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { Field, Paginacao, Vazio } from '../../components/ui.jsx';
import ProdutoPicker from '../../components/ProdutoPicker.jsx';
import { brl, dataHora, parseNumero, qtd } from '../../utils/format';
import { stepDaUnidade, TIPO_MOV, lembrarLoja } from './comum.jsx';

const LIMITE = 30;

export default function Movimentacoes({ products, locations, suppliers, alertas, reload }) {
  const toast = useToast();
  const { user } = useAuth();
  const locaisAtivos = locations.filter((l) => l.ativo);
  const localPadrao = (user.locationId && locaisAtivos.some((l) => l.id === user.locationId)) ? user.locationId : '';
  const VAZIO = { product_id: '', quantidade: '', location_origem_id: localPadrao, location_destino_id: localPadrao, motivo: '', supplier_id: '', custo_unitario: '', documento_fiscal: '' };
  const [tipo, setTipo] = useState('transferencia');
  const [form, setForm] = useState(VAZIO);
  const movimentaveis = products.filter((p) => !p.tem_ficha_tecnica && (p.ativo || tipo !== 'entrada'));
  const produto = products.find((p) => p.id === form.product_id);
  const saldoOrigem = produto && form.location_origem_id
    ? Number((produto.saldos_por_local.find((s) => s.location_id === form.location_origem_id) || { saldo: 0 }).saldo) : null;

  // Historico
  const [filtros, setFiltros] = useState({ product_id: '', location_id: '', tipo: '', data_inicio: '', data_fim: '' });
  const [hist, setHist] = useState({ itens: [], total: 0, offset: 0 });

  const carregarHistorico = useCallback(async (offset = 0) => {
    const params = new URLSearchParams({ limit: String(LIMITE), offset: String(offset) });
    for (const [k, v] of Object.entries(filtros)) if (v) params.set(k, v);
    try {
      const r = await api.get(`/stock-movements?${params}`);
      setHist({ itens: r.itens, total: r.total, offset });
    } catch (err) { toast.erro(err); }
  }, [filtros, toast]);

  useEffect(() => { carregarHistorico(0); }, [carregarHistorico]);

  async function registrar(e) {
    e.preventDefault();
    if (!form.product_id) { toast.erro('Escolha o produto.'); return; }
    try {
      const payload = { product_id: form.product_id, tipo, quantidade: parseNumero(form.quantidade), motivo: form.motivo };
      if (tipo !== 'entrada') payload.location_origem_id = form.location_origem_id;
      if (tipo !== 'saida') payload.location_destino_id = form.location_destino_id;
      if (tipo === 'entrada') {
        if (form.supplier_id) payload.supplier_id = form.supplier_id;
        if (form.custo_unitario !== '') payload.custo_unitario = parseNumero(form.custo_unitario);
        if (form.documento_fiscal) payload.documento_fiscal = form.documento_fiscal;
      }
      const r = await api.post('/stock-movements', payload);
      lembrarLoja(tipo === 'entrada' ? form.location_destino_id : form.location_origem_id);
      toast.sucesso(r.preco_custo_atualizado ? `Entrada registrada. Novo custo médio: ${brl(r.preco_custo_atualizado)}.` : `${TIPO_MOV(tipo)} registrada.`);
      setForm({ ...VAZIO, location_origem_id: form.location_origem_id, location_destino_id: form.location_destino_id });
      await reload();
      carregarHistorico(0);
    } catch (err) { toast.erro(err); }
  }

  const mudarFiltro = (campo) => (e) => setFiltros((f) => ({ ...f, [campo]: e.target.value }));

  return (
    <>
      {alertas.length > 0 && (
        <div className="card alertas-card">
          <h3>Estoque mínimo atingido ({alertas.length})</h3>
          <ul className="lista-simples">
            {alertas.map((a) => (
              <li key={`${a.tipo}-${a.id}-${a.location_id}`}>
                <span><span className="badge-alerta">{a.tipo}</span> {a.nome} — <strong>{a.location_nome}</strong></span>
                <span>{qtd(a.saldo, a.unidade)} {a.unidade} <span className="muted">(mínimo {qtd(a.estoque_minimo, a.unidade)})</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="segmentado" role="radiogroup" aria-label="Tipo de movimentação">
          {['transferencia', 'entrada', 'saida'].map((t) => (
            <button key={t} type="button" className={tipo === t ? 'ativo' : ''} onClick={() => setTipo(t)}>{TIPO_MOV(t)}</button>
          ))}
        </div>
        <form onSubmit={registrar} className="form-grid" style={{ marginTop: '14px' }}>
          <Field label="Produto *" style={{ flex: '2 1 280px' }}>
            <ProdutoPicker produtos={movimentaveis} valor={form.product_id} onSelecionar={(p) => setForm({ ...form, product_id: p.id })} />
          </Field>
          <Field label={`Quantidade *${produto ? ` (${produto.unidade})` : ''}`} style={{ flex: '0 0 130px' }}
            hint={saldoOrigem !== null && tipo !== 'entrada' ? `Disponível: ${qtd(saldoOrigem, produto.unidade)}` : undefined}>
            <input type="number" min="0" step={stepDaUnidade(produto && produto.unidade)} value={form.quantidade} onChange={(e) => setForm({ ...form, quantidade: e.target.value })} required />
          </Field>
          {tipo !== 'entrada' && (
            <Field label={tipo === 'transferencia' ? 'De (origem) *' : 'Loja *'}>
              <select value={form.location_origem_id} onChange={(e) => setForm({ ...form, location_origem_id: e.target.value })} required>
                <option value="">Escolha...</option>
                {locaisAtivos.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
              </select>
            </Field>
          )}
          {tipo !== 'saida' && (
            <Field label={tipo === 'transferencia' ? 'Para (destino) *' : 'Loja *'}>
              <select value={form.location_destino_id} onChange={(e) => setForm({ ...form, location_destino_id: e.target.value })} required>
                <option value="">Escolha...</option>
                {locaisAtivos.filter((l) => tipo !== 'transferencia' || l.id !== form.location_origem_id).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
              </select>
            </Field>
          )}
          {tipo === 'entrada' && (
            <>
              <Field label="Fornecedor">
                <select value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
                  <option value="">—</option>
                  {suppliers.filter((s) => s.ativo).map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
                </select>
              </Field>
              <Field label="Custo unitário (R$)" style={{ flex: '0 0 140px' }}><input inputMode="decimal" value={form.custo_unitario} onChange={(e) => setForm({ ...form, custo_unitario: e.target.value })} placeholder="0,00" /></Field>
              <Field label="Nota fiscal" style={{ flex: '0 0 140px' }}><input value={form.documento_fiscal} onChange={(e) => setForm({ ...form, documento_fiscal: e.target.value })} /></Field>
            </>
          )}
          <Field label="Motivo *" style={{ flex: '2 1 240px' }}>
            <input value={form.motivo} onChange={(e) => setForm({ ...form, motivo: e.target.value })}
              placeholder={tipo === 'saida' ? 'Ex: avaria, vencimento, consumo interno' : tipo === 'entrada' ? 'Ex: compra, devolução' : 'Ex: abastecer loja'} required />
          </Field>
          <button type="submit" className="btn-primario">Registrar {TIPO_MOV(tipo).toLowerCase()}</button>
        </form>
      </div>

      <div className="card">
        <h3>Histórico de movimentações</h3>
        <div className="filtros" style={{ margin: '12px 0' }}>
          <select value={filtros.product_id} onChange={mudarFiltro('product_id')} aria-label="Produto">
            <option value="">Todos os produtos</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
          </select>
          <select value={filtros.location_id} onChange={mudarFiltro('location_id')} aria-label="Loja">
            <option value="">Todas as lojas</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
          </select>
          <select value={filtros.tipo} onChange={mudarFiltro('tipo')} aria-label="Tipo">
            <option value="">Todos os tipos</option>
            <option value="entrada">Entradas</option>
            <option value="saida">Saídas</option>
            <option value="transferencia">Transferências</option>
          </select>
          <input type="date" value={filtros.data_inicio} onChange={mudarFiltro('data_inicio')} aria-label="De" />
          <input type="date" value={filtros.data_fim} onChange={mudarFiltro('data_fim')} aria-label="Até" />
        </div>
        <div className="tabela-wrap">
          <table>
            <thead><tr><th>Data</th><th>Tipo</th><th>Produto</th><th className="num">Qtd</th><th className="col-opcional">Local</th><th className="col-opcional">Detalhe</th><th className="col-opcional">Usuário</th></tr></thead>
            <tbody>
              {hist.itens.map((m) => (
                <tr key={m.id}>
                  <td>{dataHora(m.criado_em)}</td>
                  <td><span className={`tipo-${m.tipo}`}>{TIPO_MOV(m.tipo)}</span></td>
                  <td>{m.product_nome}</td>
                  <td className="num">{qtd(m.quantidade, m.unidade)}</td>
                  <td className="col-opcional">{m.location_origem_nome && m.location_destino_nome ? `${m.location_origem_nome} → ${m.location_destino_nome}` : (m.location_origem_nome || m.location_destino_nome)}</td>
                  <td className="col-opcional">
                    {m.sale_numero ? `${m.tipo === 'entrada' ? 'Estorno da venda' : 'Venda'} nº ${m.sale_numero}` : m.motivo}
                    {(m.supplier_nome || m.documento_fiscal || m.custo_unitario) && (
                      <div className="celula-sub">{[m.supplier_nome, m.custo_unitario ? `${brl(m.custo_unitario)}/un` : null, m.documento_fiscal ? `NF ${m.documento_fiscal}` : null].filter(Boolean).join(' · ')}</div>
                    )}
                  </td>
                  <td className="col-opcional">{m.usuario_nome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hist.itens.length === 0 && <Vazio>Nenhuma movimentação com esses filtros.</Vazio>}
        <Paginacao total={hist.total} limit={LIMITE} offset={hist.offset} onChange={carregarHistorico} />
      </div>
    </>
  );
}

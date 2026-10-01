import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast, useConfirm } from '../../context/UiContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { brl, brlFino, dataHora, parseNumero, pct, qtd } from '../../utils/format';
import { UNIDADES_PRODUTO, ordenarCategoriasHierarquia, SeletorFornecedores, stepDaUnidade, TIPO_MOV, lojaPadrao, lembrarLoja } from './comum.jsx';

// Detalhe do produto: dados, edicao, estoque por loja (com minimo), entrada de compra,
// ficha tecnica e ultimas movimentacoes.
export default function DetalheProduto({ productId, categories, suppliers, locations, ingredients, reload, onClose }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const { user } = useAuth();
  const [p, setP] = useState(null);
  const [movs, setMovs] = useState([]);
  const [editando, setEditando] = useState(null);
  const [minimos, setMinimos] = useState({});
  const locaisAtivos = locations.filter((l) => l.ativo);
  const localPadrao = lojaPadrao(user, locaisAtivos);
  const ENTRADA_VAZIA = { quantidade: '', location_id: localPadrao, supplier_id: '', custo_unitario: '', documento_fiscal: '', motivo: 'Compra' };
  const [entrada, setEntrada] = useState(ENTRADA_VAZIA);
  const [fichaForm, setFichaForm] = useState({ ingredient_id: '', quantidade_por_unidade: '' });

  const carregar = useCallback(async () => {
    try {
      const [d, m] = await Promise.all([
        api.get(`/products/${productId}`),
        api.get(`/stock-movements?product_id=${productId}&limit=8`),
      ]);
      setP(d);
      setMovs(m.itens);
    } catch (err) { toast.erro(err); }
  }, [productId, toast]);

  useEffect(() => { carregar(); }, [carregar]);

  async function atualizarTudo() {
    await carregar();
    reload();
  }

  if (!p) return <Modal titulo="Carregando..." onClose={onClose} largura="extra"><p className="muted">Carregando produto...</p></Modal>;

  const composto = p.ficha_tecnica.length > 0;
  const margem = Number(p.preco_venda) > 0 ? ((Number(p.preco_venda) - Number(p.preco_custo)) / Number(p.preco_venda)) * 100 : 0;
  const saldoDe = (locId) => p.saldos_por_local.find((s) => s.location_id === locId);

  function iniciarEdicao() {
    const principal = p.supplier_id || '';
    setEditando({
      nome: p.nome, categoria_id: p.categoria_id || '', barcode: p.barcode, unidade: p.unidade,
      preco_custo: String(p.preco_custo).replace('.', ','), preco_venda: String(p.preco_venda).replace('.', ','),
      supplier_id: principal,
      supplier_ids: p.fornecedores.map((f) => f.id).filter((id) => id !== principal),
    });
  }

  async function salvarEdicao(e) {
    e.preventDefault();
    try {
      await api.put(`/products/${p.id}`, {
        ...editando,
        supplier_id: editando.supplier_id || null,
        preco_custo: parseNumero(editando.preco_custo),
        preco_venda: parseNumero(editando.preco_venda),
      });
      toast.sucesso('Produto atualizado.');
      setEditando(null);
      atualizarTudo();
    } catch (err) { toast.erro(err); }
  }

  async function alternarStatus() {
    if (p.ativo && !(await confirmar({
      titulo: `Desativar "${p.nome}"?`,
      mensagem: 'O produto some do PDV e não recebe novas entradas. O histórico e o saldo continuam (ainda dá para transferir ou dar saída).',
      confirmar: 'Desativar', perigo: true,
    }))) return;
    try {
      await api.patch(`/products/${p.id}/status`, { ativo: !p.ativo });
      toast.sucesso(p.ativo ? 'Produto desativado.' : 'Produto reativado.');
      atualizarTudo();
    } catch (err) { toast.erro(err); }
  }

  async function salvarMinimo(locationId) {
    const valor = minimos[locationId];
    if (valor === undefined) return;
    const n = parseNumero(valor === '' ? '0' : valor);
    if (!(n >= 0)) { toast.erro('Estoque mínimo inválido.'); return; }
    try {
      await api.put(`/products/${p.id}/minimum`, { location_id: locationId, estoque_minimo: n });
      setMinimos((m) => { const c = { ...m }; delete c[locationId]; return c; });
      toast.sucesso('Estoque mínimo salvo.');
      atualizarTudo();
    } catch (err) { toast.erro(err); }
  }

  async function lancarEntrada(e) {
    e.preventDefault();
    try {
      const payload = {
        product_id: p.id, tipo: 'entrada', quantidade: parseNumero(entrada.quantidade),
        location_destino_id: entrada.location_id, motivo: entrada.motivo || 'Compra',
      };
      if (entrada.supplier_id) payload.supplier_id = entrada.supplier_id;
      if (entrada.custo_unitario !== '') payload.custo_unitario = parseNumero(entrada.custo_unitario);
      if (entrada.documento_fiscal) payload.documento_fiscal = entrada.documento_fiscal;
      const r = await api.post('/stock-movements', payload);
      lembrarLoja(entrada.location_id);
      toast.sucesso(r.preco_custo_atualizado ? `Entrada registrada. Novo custo médio: ${brl(r.preco_custo_atualizado)}.` : 'Entrada registrada.');
      setEntrada(ENTRADA_VAZIA);
      atualizarTudo();
    } catch (err) { toast.erro(err); }
  }

  async function addInsumo(e) {
    e.preventDefault();
    try {
      await api.post(`/products/${p.id}/ingredients`, { ingredient_id: fichaForm.ingredient_id, quantidade_por_unidade: parseNumero(fichaForm.quantidade_por_unidade) });
      setFichaForm({ ingredient_id: '', quantidade_por_unidade: '' });
      atualizarTudo();
    } catch (err) { toast.erro(err); }
  }

  async function removerInsumo(f) {
    if (!(await confirmar({ titulo: `Tirar "${f.ingredient_nome}" da ficha técnica?`, confirmar: 'Remover', perigo: true }))) return;
    try {
      await api.del(`/products/${p.id}/ingredients/${f.ingredient_id}`);
      atualizarTudo();
    } catch (err) { toast.erro(err); }
  }

  return (
    <Modal titulo={<>{p.nome} {!p.ativo && <span className="badge-inativo">inativo</span>}</>}
      subtitulo={`${p.codigo_interno} · EAN ${p.barcode}`} onClose={onClose} largura="extra">
      <div className="row-actions">
        {!editando && <button type="button" className="btn-link" onClick={iniciarEdicao}>Editar produto</button>}
        <button type="button" className={`btn-link ${p.ativo ? 'perigo' : ''}`} onClick={alternarStatus}>{p.ativo ? 'Desativar' : 'Reativar'}</button>
      </div>

      {editando ? (
        <form onSubmit={salvarEdicao} className="detail-section">
          <span className="detail-section-title">Editar produto</span>
          <div className="form-grid">
            <Field label="Nome *" style={{ flexBasis: '100%' }}><input value={editando.nome} onChange={(e) => setEditando({ ...editando, nome: e.target.value })} required minLength={3} /></Field>
            <Field label="Categoria *">
              <select value={editando.categoria_id} onChange={(e) => setEditando({ ...editando, categoria_id: e.target.value })} required>
                {ordenarCategoriasHierarquia(categories).map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.nivel)}{c.nome}</option>)}
              </select>
            </Field>
            <Field label="Unidade" style={{ flex: '0 0 120px' }}>
              <select value={editando.unidade} onChange={(e) => setEditando({ ...editando, unidade: e.target.value })}>
                {UNIDADES_PRODUTO.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
            <Field label="Código de barras *"><input inputMode="numeric" value={editando.barcode} onChange={(e) => setEditando({ ...editando, barcode: e.target.value })} required /></Field>
            <Field label="Preço de custo (R$) *"><input inputMode="decimal" value={editando.preco_custo} onChange={(e) => setEditando({ ...editando, preco_custo: e.target.value })} required /></Field>
            <Field label="Preço de venda (R$) *"><input inputMode="decimal" value={editando.preco_venda} onChange={(e) => setEditando({ ...editando, preco_venda: e.target.value })} required /></Field>
            <Field label="Fornecedores">
              <SeletorFornecedores suppliers={suppliers} principal={editando.supplier_id} extras={editando.supplier_ids}
                onChange={(principal, extras) => setEditando({ ...editando, supplier_id: principal, supplier_ids: principal ? extras : [] })} />
            </Field>
          </div>
          <div className="row-actions">
            <button type="submit" className="btn-primario">Salvar alterações</button>
            <button type="button" className="btn-link" onClick={() => setEditando(null)}>Cancelar</button>
          </div>
        </form>
      ) : (
        <>
          <div className="detail-grid">
            <div><span className="label">Unidade</span><span className="valor">{p.unidade}</span></div>
            <div><span className="label">Custo</span><span className="valor destaque">{brl(p.preco_custo)}</span></div>
            <div><span className="label">Venda</span><span className="valor destaque">{brl(p.preco_venda)}</span></div>
            <div><span className="label">Margem</span><span className="valor">{pct(margem.toFixed(1))}</span></div>
          </div>
          <div className="chips">
            <span className="muted">Fornecedores:</span>
            {p.fornecedores.length === 0 && <span className="muted">nenhum</span>}
            {p.fornecedores.map((f) => <span key={f.id} className={`chip ${f.principal ? 'principal' : ''}`}>{f.nome}{f.principal ? ' (principal)' : ''}</span>)}
          </div>
        </>
      )}

      {!composto && (
        <div className="detail-section">
          <span className="detail-section-title">Estoque por loja</span>
          <div className="tabela-wrap">
            <table className="compacta">
              <thead><tr><th>Loja</th><th className="num">Saldo</th><th>Mínimo (alerta)</th><th /></tr></thead>
              <tbody>
                {locaisAtivos.map((l) => {
                  const s = saldoDe(l.id);
                  return (
                    <tr key={l.id}>
                      <td>{l.nome}</td>
                      <td className={`num ${s && s.abaixo_minimo ? 'texto-alerta' : ''}`}>{qtd(s ? s.saldo : 0, p.unidade)} {p.unidade}</td>
                      <td>
                        <input className="input-curto" inputMode="decimal" aria-label={`Estoque mínimo em ${l.nome}`}
                          value={minimos[l.id] ?? qtd(s ? s.estoque_minimo : 0, p.unidade)}
                          onChange={(e) => setMinimos({ ...minimos, [l.id]: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); salvarMinimo(l.id); } }} />
                      </td>
                      <td>{minimos[l.id] !== undefined && <button type="button" className="btn-link" onClick={() => salvarMinimo(l.id)}>Salvar</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!composto && p.ativo && (
        <form onSubmit={lancarEntrada} className="detail-section">
          <span className="detail-section-title">Entrada de compra</span>
          <div className="form-grid">
            <Field label="Quantidade *" style={{ flex: '0 0 120px' }}><input type="number" min="0" step={stepDaUnidade(p.unidade)} value={entrada.quantidade} onChange={(e) => setEntrada({ ...entrada, quantidade: e.target.value })} required /></Field>
            <Field label="Loja *">
              <select value={entrada.location_id} onChange={(e) => setEntrada({ ...entrada, location_id: e.target.value })} required>
                {locaisAtivos.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
              </select>
            </Field>
            <Field label="Fornecedor">
              <select value={entrada.supplier_id} onChange={(e) => setEntrada({ ...entrada, supplier_id: e.target.value })}>
                <option value="">—</option>
                {suppliers.filter((s) => s.ativo).map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
              </select>
            </Field>
            <Field label="Custo unitário (R$)" style={{ flex: '0 0 140px' }}><input inputMode="decimal" value={entrada.custo_unitario} onChange={(e) => setEntrada({ ...entrada, custo_unitario: e.target.value })} placeholder="0,00" /></Field>
            <Field label="Nota fiscal" style={{ flex: '0 0 140px' }}><input value={entrada.documento_fiscal} onChange={(e) => setEntrada({ ...entrada, documento_fiscal: e.target.value })} /></Field>
            <button type="submit" className="btn-primario">Lançar entrada</button>
          </div>
          <span className="form-hint">Com o custo unitário, o custo do produto é recalculado pela média ponderada. Para vários produtos da mesma nota, use a aba "Entrada por nota".</span>
        </form>
      )}

      {(composto || p.saldos_por_local.every((s) => Number(s.saldo) === 0)) && (
        <div className="detail-section">
          <span className="detail-section-title">Ficha técnica {composto ? '' : '(transforma em produto composto)'}</span>
          {composto && (
            <ul className="lista-simples">
              {p.ficha_tecnica.map((f) => (
                <li key={f.id}>
                  <span>{f.ingredient_nome} — {qtd(f.quantidade_por_unidade)} {f.unidade}</span>
                  <span><span className="muted">{brl(f.custo_fracionado)}</span> <button type="button" className="btn-link" onClick={() => removerInsumo(f)}>Remover</button></span>
                </li>
              ))}
              <li><strong>Custo total dos insumos</strong><strong>{brl(p.ficha_tecnica.reduce((s, f) => s + Number(f.custo_fracionado), 0))}</strong></li>
            </ul>
          )}
          <form onSubmit={addInsumo} className="form-grid">
            <Field label="Insumo">
              <select value={fichaForm.ingredient_id} onChange={(e) => setFichaForm({ ...fichaForm, ingredient_id: e.target.value })} required>
                <option value="">Escolha...</option>
                {ingredients.filter((i) => i.ativo).map((i) => <option key={i.id} value={i.id}>{i.nome} ({brlFino(i.custo_unitario)}/{i.unidade})</option>)}
              </select>
            </Field>
            <Field label="Qtd por unidade" style={{ flex: '0 0 150px' }}><input inputMode="decimal" value={fichaForm.quantidade_por_unidade} onChange={(e) => setFichaForm({ ...fichaForm, quantidade_por_unidade: e.target.value })} required /></Field>
            <button type="submit" className="btn-link">+ Adicionar</button>
          </form>
        </div>
      )}

      <div className="detail-section">
        <span className="detail-section-title">Últimas movimentações</span>
        {movs.length === 0 && <span className="muted">Nenhuma movimentação.</span>}
        <ul className="lista-simples">
          {movs.map((m) => (
            <li key={m.id}>
              <span><strong className={`tipo-${m.tipo}`}>{TIPO_MOV(m.tipo)}</strong> {qtd(m.quantidade, m.unidade)} · {m.sale_numero ? `Venda nº ${m.sale_numero}` : m.motivo}</span>
              <span className="muted">{dataHora(m.criado_em)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

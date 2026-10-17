import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import ProdutoPicker from '../../components/ProdutoPicker.jsx';
import { brl, parseNumero, qtd } from '../../utils/format';
import { temModulo } from '../../utils/permissions.js';

// Grupos de complementos (ex.: "Adicionais" 0 a 3; "Escolha a bebida" 1) e as opcoes de cada um.
// Cada opcao tem preco e pode baixar um insumo (Bacon extra = 30 g) ou um produto (Coca lata do combo).
export default function Complementos({ products = [], ingredients = [], lanchonete = true }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const { user } = useAuth();
  const usaIfood = temModulo(user, 'delivery_apps');
  const [grupos, setGrupos] = useState(null);
  const [grupoForm, setGrupoForm] = useState(null); // {} novo | grupo em edicao
  const [opcaoForm, setOpcaoForm] = useState(null); // { grupo, opcao? }

  const carregar = useCallback(() => api.get('/complement-groups').then(setGrupos).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);

  async function alternarOpcao(o) {
    try { await api.patch(`/complements/${o.id}`, { ativo: !o.ativo }); toast.sucesso(o.ativo ? `"${o.nome}" desativado` : `"${o.nome}" reativado`); carregar(); } catch (err) { toast.erro(err); }
  }
  async function excluirOpcao(o) {
    if (!(await confirmar({ titulo: `Excluir "${o.nome}"?`, confirmar: 'Excluir', perigo: true }))) return;
    try { await api.del(`/complements/${o.id}`); toast.sucesso('Complemento excluído'); carregar(); } catch (err) { toast.erro(err); }
  }
  async function excluirGrupo(g) {
    if (!(await confirmar({ titulo: `Excluir o grupo "${g.nome}"?`, mensagem: 'As opções do grupo também são excluídas e o grupo sai dos produtos.', confirmar: 'Excluir', perigo: true }))) return;
    try { await api.del(`/complement-groups/${g.id}`); toast.sucesso('Grupo excluído'); carregar(); } catch (err) { toast.erro(err); }
  }
  async function alternarGrupo(g) {
    try { await api.patch(`/complement-groups/${g.id}`, { ativo: !g.ativo }); carregar(); } catch (err) { toast.erro(err); }
  }

  const baixa = (o) => {
    if (o.ingredient_id) return `baixa ${qtd(o.quantidade_insumo)} ${o.insumo_unidade || ''} de ${o.insumo_nome}`;
    if (o.product_id) return `baixa ${qtd(o.quantidade_produto)}× ${o.produto_nome}`;
    return 'sem baixa de estoque';
  };

  return (
    <div className="form-stack">
      <div className="es-resumo">
        <b>Complementos</b> são os adicionais e as escolhas do cliente. Monte grupos (ex.: <b>"Adicionais"</b>: Bacon extra, Cheddar — até 3; <b>"Escolha a bebida"</b> do combo — obrigatório 1) e marque no cadastro do produto quais grupos ele oferece. O preço soma no item e a baixa sai do estoque/insumos.
      </div>
      <div><button type="button" className="btn-primario" onClick={() => setGrupoForm({})}>+ Novo grupo</button></div>
      {grupos === null && <p className="muted">Carregando…</p>}
      {grupos && grupos.length === 0 && <div className="card"><p className="muted" style={{ margin: 0 }}>Nenhum grupo ainda. Comece por "Adicionais".</p></div>}
      {(grupos || []).map((g) => (
        <div key={g.id} className={`card comp-grupo ${g.ativo ? '' : 'row-inativa'}`}>
          <div className="ped-head" style={{ margin: 0 }}>
            <h3 style={{ margin: 0 }}>{g.nome} {!g.ativo && <span className="badge-inativo">inativo</span>}</h3>
            <span className="ped-tag">{g.minimo > 0 ? `obrigatório: ${g.minimo === g.maximo ? g.minimo : `${g.minimo} a ${g.maximo}`}` : `opcional: até ${g.maximo}`}</span>
            <span className="muted">· em {g.produtos} produto(s)</span>
            <span className="row-actions" style={{ marginLeft: 'auto' }}>
              <button type="button" className="btn-link" onClick={() => setOpcaoForm({ grupo: g })}>+ Opção</button>
              <button type="button" className="btn-link" onClick={() => setGrupoForm(g)}>Editar</button>
              <button type="button" className="btn-link" onClick={() => alternarGrupo(g)}>{g.ativo ? 'Desativar' : 'Reativar'}</button>
              <button type="button" className="btn-link perigo" onClick={() => excluirGrupo(g)}>Excluir</button>
            </span>
          </div>
          {g.opcoes.length === 0 ? <p className="form-hint">Nenhuma opção. Clique em "+ Opção".</p> : (
            <div className="tabela-wrap">
              <table className="compacta">
                <thead><tr><th>Opção</th><th className="num">Preço</th><th>Estoque</th>{usaIfood && <th>Código iFood</th>}<th /></tr></thead>
                <tbody>
                  {g.opcoes.map((o) => (
                    <tr key={o.id} className={o.ativo ? '' : 'row-inativa'}>
                      <td><b>{o.nome}</b>{!o.ativo && <> <span className="badge-inativo">inativo</span></>}</td>
                      <td className="num">{Number(o.preco) > 0 ? `+ ${brl(o.preco)}` : 'grátis'}</td>
                      <td className="muted">{baixa(o)}</td>
                      {usaIfood && <td>{o.codigo || <span className="muted">—</span>}</td>}
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn-link" onClick={() => setOpcaoForm({ grupo: g, opcao: o })}>Editar</button>
                        <button type="button" className="btn-link" onClick={() => alternarOpcao(o)}>{o.ativo ? 'Desativar' : 'Reativar'}</button>
                        <button type="button" className="btn-link perigo" onClick={() => excluirOpcao(o)}>Excluir</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
      {grupoForm && <GrupoModal grupo={grupoForm} onClose={() => setGrupoForm(null)} onSalvo={() => { setGrupoForm(null); carregar(); }} />}
      {opcaoForm && <OpcaoModal {...opcaoForm} products={products} ingredients={ingredients} lanchonete={lanchonete} usaIfood={usaIfood}
        onClose={() => setOpcaoForm(null)} onSalvo={() => { setOpcaoForm(null); carregar(); }} />}
    </div>
  );
}

function GrupoModal({ grupo, onClose, onSalvo }) {
  const toast = useToast();
  const novo = !grupo.id;
  const [f, setF] = useState({ nome: grupo.nome || '', minimo: String(grupo.minimo ?? 0), maximo: String(grupo.maximo ?? 1) });
  async function salvar(e) {
    e.preventDefault();
    const corpo = { nome: f.nome, minimo: Number(f.minimo), maximo: Number(f.maximo) };
    try {
      if (novo) await api.post('/complement-groups', corpo); else await api.patch(`/complement-groups/${grupo.id}`, corpo);
      toast.sucesso(novo ? `Grupo "${f.nome}" criado` : 'Grupo salvo');
      onSalvo();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo={novo ? 'Novo grupo de complementos' : `Editar grupo · ${grupo.nome}`} onClose={onClose}>
      <form className="form-stack" onSubmit={salvar}>
        <Field label="Nome do grupo *"><input autoFocus value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder='Ex.: Adicionais, Escolha a bebida, Ponto da carne' /></Field>
        <div className="form-grid">
          <Field label="Mínimo" hint="0 = opcional; 1 ou mais = o cliente é obrigado a escolher"><input type="number" min="0" value={f.minimo} onChange={(e) => setF({ ...f, minimo: e.target.value })} /></Field>
          <Field label="Máximo" hint="Quantas opções (somando as quantidades) ele pode escolher"><input type="number" min="1" value={f.maximo} onChange={(e) => setF({ ...f, maximo: e.target.value })} /></Field>
        </div>
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button type="submit" disabled={f.nome.trim().length < 2}>{novo ? 'Criar grupo' : 'Salvar'}</button></div>
      </form>
    </Modal>
  );
}

function OpcaoModal({ grupo, opcao = {}, products, ingredients, lanchonete, usaIfood, onClose, onSalvo }) {
  const toast = useToast();
  const novo = !opcao.id;
  const [f, setF] = useState({
    nome: opcao.nome || '', preco: opcao.preco !== undefined ? String(Number(opcao.preco)).replace('.', ',') : '0,00', codigo: opcao.codigo || '',
    baixa: opcao.ingredient_id ? 'insumo' : opcao.product_id ? 'produto' : 'nenhuma',
    ingredient_id: opcao.ingredient_id || '', quantidade_insumo: opcao.quantidade_insumo ? String(Number(opcao.quantidade_insumo)).replace('.', ',') : '',
    product_id: opcao.product_id || '', quantidade_produto: opcao.quantidade_produto ? String(Number(opcao.quantidade_produto)).replace('.', ',') : '1',
  });
  const insumo = ingredients.find((i) => i.id === f.ingredient_id);
  async function salvar(e) {
    e.preventDefault();
    const corpo = {
      nome: f.nome, preco: parseNumero(f.preco) || 0, codigo: f.codigo,
      ingredient_id: f.baixa === 'insumo' ? f.ingredient_id || null : null, quantidade_insumo: f.baixa === 'insumo' ? parseNumero(f.quantidade_insumo) : null,
      product_id: f.baixa === 'produto' ? f.product_id || null : null, quantidade_produto: f.baixa === 'produto' ? parseNumero(f.quantidade_produto) : null,
    };
    try {
      if (novo) await api.post(`/complement-groups/${grupo.id}/options`, corpo); else await api.patch(`/complements/${opcao.id}`, corpo);
      toast.sucesso(novo ? `"${f.nome}" adicionado em ${grupo.nome}` : 'Complemento salvo');
      onSalvo();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo={novo ? `Nova opção em "${grupo.nome}"` : `Editar · ${opcao.nome}`} onClose={onClose} largura="larga">
      <form className="form-stack" onSubmit={salvar}>
        <div className="form-grid">
          <Field label="Nome *" style={{ flex: '2 1 240px' }}><input autoFocus value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder="Ex.: Bacon extra" /></Field>
          <Field label="Preço (R$)" hint="0 = sem acréscimo"><input inputMode="decimal" value={f.preco} onChange={(e) => setF({ ...f, preco: e.target.value })} /></Field>
          {usaIfood && <Field label="Código PDV no iFood" hint="O mesmo código do complemento no cardápio do iFood"><input value={f.codigo} onChange={(e) => setF({ ...f, codigo: e.target.value.toUpperCase() })} placeholder="Ex.: ADC-BACON" maxLength={60} /></Field>}
        </div>
        <Field label="O que sai do estoque">
          <div className="ped-seg2">
            <button type="button" className={f.baixa === 'nenhuma' ? 'on' : ''} onClick={() => setF({ ...f, baixa: 'nenhuma' })}>Nada</button>
            {lanchonete && <button type="button" className={f.baixa === 'insumo' ? 'on' : ''} onClick={() => setF({ ...f, baixa: 'insumo' })}>Um insumo</button>}
            <button type="button" className={f.baixa === 'produto' ? 'on' : ''} onClick={() => setF({ ...f, baixa: 'produto' })}>Um produto</button>
          </div>
        </Field>
        {f.baixa === 'insumo' && (
          <div className="form-grid">
            <Field label="Insumo *"><select value={f.ingredient_id} onChange={(e) => setF({ ...f, ingredient_id: e.target.value })}>
              <option value="">Escolha…</option>
              {ingredients.filter((i) => i.ativo || i.id === f.ingredient_id).map((i) => <option key={i.id} value={i.id}>{i.nome} ({i.unidade})</option>)}
            </select></Field>
            <Field label={`Quantidade por unidade${insumo ? ` (${insumo.unidade})` : ''} *`} hint="Ex.: 30 para 30 g de bacon"><input inputMode="decimal" value={f.quantidade_insumo} onChange={(e) => setF({ ...f, quantidade_insumo: e.target.value })} /></Field>
          </div>
        )}
        {f.baixa === 'produto' && (
          <div className="form-grid">
            <Field label="Produto *" style={{ flex: '2 1 280px' }}><ProdutoPicker produtos={products.filter((p) => p.ativo && !p.e_combo)} valor={f.product_id} onSelecionar={(p) => setF({ ...f, product_id: p.id })} placeholder="Ex.: Refrigerante lata" /></Field>
            <Field label="Quantidade *"><input inputMode="decimal" value={f.quantidade_produto} onChange={(e) => setF({ ...f, quantidade_produto: e.target.value })} /></Field>
          </div>
        )}
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button type="submit" disabled={!f.nome.trim()}>{novo ? 'Adicionar' : 'Salvar'}</button></div>
      </form>
    </Modal>
  );
}

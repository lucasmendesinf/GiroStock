import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useToast, useConfirm } from '../context/UiContext.jsx';
import { Field, Modal, Vazio } from '../components/ui.jsx';
import { brl, data, qtd } from '../utils/format';
import { useAuth } from '../context/AuthContext.jsx';
import { pode } from '../utils/permissions.js';

const CATEGORIAS = ['Bebidas', 'Cigarros e Tabacaria', 'Alimentos e Insumos', 'Embalagens', 'Outros'];
const FORM_VAZIO = { nome: '', documento: '', telefone: '', email: '', categoria: CATEGORIAS[0], prazo_medio_dias: '' };

function formatarDocumento(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d;
}

function formatarTelefone(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  if (d.length === 11) return d.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
  if (d.length === 10) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, '($1) $2-$3');
  return tel;
}

function normalizar(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export default function Suppliers() {
  const toast = useToast();
  const confirmar = useConfirm();
  const { user } = useAuth();
  const podeCriar = pode(user, 'fornecedores.criar');
  const podeEditar = pode(user, 'fornecedores.editar');
  const [suppliers, setSuppliers] = useState([]);
  const [busca, setBusca] = useState('');
  const [situacao, setSituacao] = useState('ativos');
  const [formAberto, setFormAberto] = useState(null); // null | 'novo' | fornecedor
  const [detalhe, setDetalhe] = useState(null);

  const reload = useCallback(async () => {
    try { setSuppliers(await api.get('/suppliers')); } catch (err) { toast.erro(err); }
  }, [toast]);
  useEffect(() => { reload(); }, [reload]);

  const filtrados = useMemo(() => {
    const t = normalizar(busca.trim());
    const digitos = busca.replace(/\D/g, '');
    return suppliers.filter((s) => {
      if (situacao === 'ativos' && !s.ativo) return false;
      if (situacao === 'inativos' && s.ativo) return false;
      if (!t) return true;
      return normalizar(s.nome).includes(t) || (digitos && s.documento.includes(digitos)) || normalizar(s.categoria).includes(t);
    });
  }, [suppliers, busca, situacao]);

  async function alternarStatus(s) {
    if (s.ativo && !(await confirmar({
      titulo: `Desativar "${s.nome}"?`,
      mensagem: 'Ele deixa de aparecer para novos vínculos e novas compras. O histórico continua.',
      confirmar: 'Desativar', perigo: true,
    }))) return;
    try {
      await api.patch(`/suppliers/${s.id}/status`, { ativo: !s.ativo });
      toast.sucesso(s.ativo ? 'Fornecedor desativado.' : 'Fornecedor reativado.');
      reload();
    } catch (err) { toast.erro(err); }
  }

  async function abrirDetalhe(s) {
    try { setDetalhe(await api.get(`/suppliers/${s.id}`)); } catch (err) { toast.erro(err); }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Fornecedores</h2>
        {podeCriar && <button type="button" className="btn-primario" onClick={() => setFormAberto('novo')}>+ Novo fornecedor</button>}
      </div>

      <div className="toolbar">
        <input className="toolbar-busca" placeholder="Buscar por nome, CPF/CNPJ ou categoria" value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar fornecedor" />
        <select value={situacao} onChange={(e) => setSituacao(e.target.value)} aria-label="Situação">
          <option value="ativos">Ativos</option>
          <option value="inativos">Inativos</option>
          <option value="todos">Todos</option>
        </select>
      </div>

      <div className="card">
        <div className="tabela-wrap">
          <table>
            <thead><tr><th>Fornecedor</th><th className="col-opcional">Contato</th><th className="col-opcional">Categoria</th><th className="num col-opcional">Produtos</th><th /></tr></thead>
            <tbody>
              {filtrados.map((s) => (
                <tr key={s.id} className={s.ativo ? '' : 'row-inativa'}>
                  <td>
                    <div className="celula-principal">{s.nome} {!s.ativo && <span className="badge-inativo">inativo</span>}</div>
                    <div className="celula-sub">{formatarDocumento(s.documento)}</div>
                  </td>
                  <td className="col-opcional">{formatarTelefone(s.telefone)}{s.email && <div className="celula-sub">{s.email}</div>}</td>
                  <td className="col-opcional">{s.categoria}{s.prazo_medio_dias !== null && <div className="celula-sub">prazo {s.prazo_medio_dias} dias</div>}</td>
                  <td className="num col-opcional">{s.produto_count}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn-link" onClick={() => abrirDetalhe(s)}>Produtos e compras</button>
                      {podeEditar && <button className="btn-link" onClick={() => setFormAberto(s)}>Editar</button>}
                      {podeEditar && <button className={`btn-link ${s.ativo ? 'perigo' : ''}`} onClick={() => alternarStatus(s)}>{s.ativo ? 'Desativar' : 'Reativar'}</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtrados.length === 0 && <Vazio>{suppliers.length === 0 ? 'Nenhum fornecedor cadastrado ainda.' : 'Nenhum fornecedor encontrado.'}</Vazio>}
      </div>

      {formAberto && <FormFornecedor fornecedor={formAberto === 'novo' ? null : formAberto} onClose={() => setFormAberto(null)} onSalvo={() => { setFormAberto(null); reload(); }} />}

      {detalhe && (
        <Modal titulo={detalhe.nome} subtitulo={`${formatarDocumento(detalhe.documento)} · ${detalhe.categoria}${detalhe.prazo_medio_dias !== null ? ` · prazo médio ${detalhe.prazo_medio_dias} dias` : ''}`}
          onClose={() => setDetalhe(null)} largura="larga">
          <div className="detail-section">
            <span className="detail-section-title">Produtos fornecidos ({detalhe.produtos.length})</span>
            {detalhe.produtos.length === 0 && <span className="muted">Nenhum produto vinculado.</span>}
            <ul className="lista-simples">
              {detalhe.produtos.map((p) => (
                <li key={p.id}>
                  <span>{p.codigo_interno} · {p.nome} {p.principal && <span className="chip principal">principal</span>} {!p.ativo && <span className="badge-inativo">inativo</span>}</span>
                  <span className="muted">custo {brl(p.preco_custo)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="detail-section">
            <span className="detail-section-title">Últimas compras</span>
            {detalhe.entradas.length === 0 && <span className="muted">Nenhuma entrada registrada com este fornecedor.</span>}
            <ul className="lista-simples">
              {detalhe.entradas.map((m) => (
                <li key={m.id}>
                  <span>{data(m.criado_em)} · {m.product_nome} · {qtd(m.quantidade)} → {m.location_nome}</span>
                  <span className="muted">{m.custo_unitario ? `${brl(m.custo_unitario)}/un` : 'sem custo'}{m.documento_fiscal ? ` · NF ${m.documento_fiscal}` : ''}</span>
                </li>
              ))}
            </ul>
          </div>
        </Modal>
      )}
    </div>
  );
}

function FormFornecedor({ fornecedor, onClose, onSalvo }) {
  const toast = useToast();
  const [form, setForm] = useState(fornecedor ? {
    nome: fornecedor.nome, documento: formatarDocumento(fornecedor.documento), telefone: formatarTelefone(fornecedor.telefone || ''),
    email: fornecedor.email || '', categoria: fornecedor.categoria, prazo_medio_dias: fornecedor.prazo_medio_dias ?? '',
  } : FORM_VAZIO);

  async function salvar(e) {
    e.preventDefault();
    const payload = { ...form, prazo_medio_dias: form.prazo_medio_dias === '' ? null : Number(form.prazo_medio_dias) };
    try {
      if (fornecedor) await api.put(`/suppliers/${fornecedor.id}`, payload);
      else await api.post('/suppliers', payload);
      toast.sucesso(fornecedor ? 'Fornecedor atualizado.' : 'Fornecedor cadastrado.');
      onSalvo();
    } catch (err) { toast.erro(err); }
  }

  return (
    <Modal titulo={fornecedor ? 'Editar fornecedor' : 'Novo fornecedor'} onClose={onClose} largura="larga">
      <form onSubmit={salvar} className="form-stack">
        <Field label="Nome / razão social *"><input autoFocus value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required /></Field>
        <div className="form-grid">
          <Field label="CPF ou CNPJ *" hint="Pode digitar com pontuação"><input inputMode="numeric" value={form.documento} onChange={(e) => setForm({ ...form, documento: e.target.value })} required /></Field>
          <Field label="Telefone *"><input inputMode="tel" value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} placeholder="(41) 99999-0000" required /></Field>
        </div>
        <div className="form-grid">
          <Field label="E-mail"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Categoria">
            <select value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value })}>
              {CATEGORIAS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Prazo médio de pagamento (dias)" style={{ flex: '0 0 200px' }}>
            <input type="number" min="0" step="1" value={form.prazo_medio_dias} onChange={(e) => setForm({ ...form, prazo_medio_dias: e.target.value })} />
          </Field>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit">{fornecedor ? 'Salvar alterações' : 'Cadastrar'}</button>
        </div>
      </form>
    </Modal>
  );
}

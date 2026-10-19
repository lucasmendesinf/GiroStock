import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { brl, parseNumero, qtd } from '../../utils/format';
import { UNIDADES_PRODUTO, ordenarCategoriasHierarquia } from './comum.jsx';

// Grades de variacoes (cor, tamanho, voltagem): cada combinacao vira um produto comum, com codigo de barras, preco e
// estoque proprios (aparece no PDV e no estoque como qualquer produto). Sem codigo de barras, o sistema gera um interno.
const MAX_ATRIBUTOS = 3;
const SUGESTOES = ['Cor', 'Tamanho', 'Voltagem', 'Sabor', 'Modelo', 'Capacidade'];
const separarValores = (t) => [...new Set(String(t || '').split(/[,;\n]/).map((v) => v.trim().replace(/\s+/g, ' ')).filter(Boolean))];
const rotuloVariacao = (atributos, v) => atributos.map((a) => v[a.nome]).join(' / ');

function combinacoes(atributos) {
  let r = [{}];
  for (const a of atributos) r = r.flatMap((c) => a.valores.map((v) => ({ ...c, [a.nome]: v })));
  return r;
}

// Cadastro de uma grade nova.
export function FormGrade({ categories, suppliers, locations, reload, onClose, onSalvo }) {
  const toast = useToast();
  const arvore = ordenarCategoriasHierarquia(categories);
  const locaisAtivos = locations.filter((l) => l.ativo);
  const [f, setF] = useState({ nome: '', categoria_id: '', unidade: 'UN', preco_custo: '', preco_venda: '', supplier_id: '', location_id: '' });
  const [atributos, setAtributos] = useState([{ nome: 'Cor', texto: '' }, { nome: 'Tamanho', texto: '' }]);
  const [linhas, setLinhas] = useState({}); // chave -> { criar, barcode, preco_venda, estoque_inicial }
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const validos = atributos.map((a) => ({ nome: a.nome.trim(), valores: separarValores(a.texto) })).filter((a) => a.nome && a.valores.length);
  const combos = useMemo(() => (validos.length ? combinacoes(validos) : []), [JSON.stringify(validos)]); // eslint-disable-line react-hooks/exhaustive-deps
  const chave = (v) => JSON.stringify(validos.map((a) => v[a.nome]));
  const linha = (v) => ({ criar: true, barcode: '', preco_venda: '', estoque_inicial: '', ...(linhas[chave(v)] || {}) });
  const mudarLinha = (v, campo, valor) => setLinhas({ ...linhas, [chave(v)]: { ...linha(v), [campo]: valor } });
  const marcadas = combos.filter((v) => linha(v).criar).length;

  async function salvar(e) {
    e.preventDefault();
    setErro('');
    if (f.nome.trim().length < 3) return setErro('Informe o nome da grade (ex.: Camiseta Básica).');
    if (!f.categoria_id) return setErro('Escolha a categoria.');
    if (!validos.length) return setErro('Informe ao menos um atributo com valores (ex.: Cor: Preta, Branca).');
    if (!marcadas) return setErro('Marque ao menos uma variação.');
    setSalvando(true);
    try {
      const g = await api.post('/grades', {
        nome: f.nome.trim(), categoria_id: f.categoria_id, unidade: f.unidade, supplier_id: f.supplier_id || null,
        preco_custo: parseNumero(f.preco_custo), preco_venda: parseNumero(f.preco_venda), location_id: f.location_id || null,
        atributos: validos,
        variacoes: combos.map((v) => {
          const l = linha(v);
          return {
            variacao: v, criar: l.criar, barcode: l.barcode.replace(/\D/g, '') || undefined,
            preco_venda: l.preco_venda.trim() ? parseNumero(l.preco_venda) : undefined,
            estoque_inicial: l.estoque_inicial.trim() ? parseNumero(l.estoque_inicial) : 0,
          };
        }),
      });
      toast.sucesso(`Grade criada com ${g.variacoes.length} variação(ões)`);
      await reload();
      onSalvo(g);
    } catch (err) { setErro(err.message); toast.erro(err); } finally { setSalvando(false); }
  }

  return (
    <Modal titulo="Nova grade de variações" subtitulo="Cor, tamanho, voltagem… cada combinação vira um produto com estoque e código de barras próprios." onClose={onClose} largura="extra">
      <form className="form-stack" onSubmit={salvar} noValidate>
        <div className="form-grid">
          <Field label="Nome base *" style={{ flexBasis: '100%' }}><input autoFocus value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder="Ex.: Camiseta Básica Algodão" maxLength={120} /></Field>
          <Field label="Categoria *">
            <select value={f.categoria_id} onChange={(e) => setF({ ...f, categoria_id: e.target.value })}>
              <option value="">Escolha...</option>
              {arvore.map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.nivel)}{c.nome}</option>)}
            </select>
          </Field>
          <Field label="Unidade" style={{ flex: '0 0 110px' }}>
            <select value={f.unidade} onChange={(e) => setF({ ...f, unidade: e.target.value })}>{UNIDADES_PRODUTO.map((u) => <option key={u} value={u}>{u}</option>)}</select>
          </Field>
          <Field label="Custo (R$) *"><input inputMode="decimal" value={f.preco_custo} onChange={(e) => setF({ ...f, preco_custo: e.target.value })} placeholder="0,00" /></Field>
          <Field label="Venda (R$) *" hint="Igual para todas; dá para mudar por variação abaixo"><input inputMode="decimal" value={f.preco_venda} onChange={(e) => setF({ ...f, preco_venda: e.target.value })} placeholder="0,00" /></Field>
          <Field label="Fornecedor">
            <select value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}><option value="">—</option>{suppliers.filter((s) => s.ativo !== false).map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}</select>
          </Field>
        </div>

        <div className="card form-stack" style={{ margin: 0 }}>
          <b>Atributos (até {MAX_ATRIBUTOS})</b>
          {atributos.map((a, i) => (
            <div key={i} className="grade-atributo">
              <input list="grade-sugestoes" value={a.nome} onChange={(e) => setAtributos(atributos.map((x, j) => (j === i ? { ...x, nome: e.target.value } : x)))} placeholder="Atributo (ex.: Cor)" aria-label={`Atributo ${i + 1}`} maxLength={30} />
              <input value={a.texto} onChange={(e) => setAtributos(atributos.map((x, j) => (j === i ? { ...x, texto: e.target.value } : x)))} placeholder="Valores separados por vírgula (ex.: Preta, Branca, Azul)" aria-label={`Valores de ${a.nome || `atributo ${i + 1}`}`} />
              <button type="button" className="grade-remover" onClick={() => setAtributos(atributos.filter((_, j) => j !== i))} aria-label="Remover atributo" title="Remover atributo">×</button>
            </div>
          ))}
          <datalist id="grade-sugestoes">{SUGESTOES.map((s) => <option key={s} value={s} />)}</datalist>
          {atributos.length < MAX_ATRIBUTOS && <div><button type="button" className="btn-link" onClick={() => setAtributos([...atributos, { nome: '', texto: '' }])}>+ Atributo</button></div>}
        </div>

        {combos.length > 0 && (
          <div className="card" style={{ margin: 0 }}>
            <div className="ped-head" style={{ marginBottom: 6 }}>
              <b>{marcadas} de {combos.length} variação(ões)</b>
              <Field label="Loja do estoque inicial" style={{ margin: 0, minWidth: 220 }}>
                <select value={f.location_id} onChange={(e) => setF({ ...f, location_id: e.target.value })}><option value="">Sem estoque inicial</option>{locaisAtivos.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select>
              </Field>
            </div>
            <div className="tabela-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
              <table className="tabela-cartoes grade-tabela">
                <thead><tr><th>Criar</th><th>Variação</th><th>Código de barras</th><th className="num">Venda (R$)</th>{f.location_id && <th className="num">Estoque inicial</th>}</tr></thead>
                <tbody>
                  {combos.map((v) => {
                    const l = linha(v);
                    return (
                      <tr key={chave(v)} style={{ opacity: l.criar ? 1 : 0.5 }}>
                        <td><input type="checkbox" checked={l.criar} onChange={(e) => mudarLinha(v, 'criar', e.target.checked)} aria-label={`Criar ${rotuloVariacao(validos, v)}`} /></td>
                        <td><b>{rotuloVariacao(validos, v)}</b></td>
                        <td><input inputMode="numeric" value={l.barcode} onChange={(e) => mudarLinha(v, 'barcode', e.target.value)} placeholder="gerar automático" disabled={!l.criar} aria-label="Código de barras" /></td>
                        <td className="num"><input inputMode="decimal" value={l.preco_venda} onChange={(e) => mudarLinha(v, 'preco_venda', e.target.value)} placeholder={f.preco_venda || 'o da grade'} disabled={!l.criar} aria-label="Preço de venda" style={{ maxWidth: 110 }} /></td>
                        {f.location_id && <td className="num"><input inputMode="decimal" value={l.estoque_inicial} onChange={(e) => mudarLinha(v, 'estoque_inicial', e.target.value)} placeholder="0" disabled={!l.criar} aria-label="Estoque inicial" style={{ maxWidth: 90 }} /></td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="form-hint" style={{ margin: '6px 0 0' }}>Sem código de barras, o sistema gera um código interno (EAN começando com 2) para etiquetar.</p>
          </div>
        )}
        {erro && <div className="es-erro">{erro}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" disabled={salvando}>{salvando ? 'Criando...' : `Criar ${marcadas || ''} variação(ões)`}</button>
        </div>
      </form>
    </Modal>
  );
}

// Grade existente: renomear, preco em lote, novos valores e as variacoes (cada uma abre a edicao normal do produto).
export function EditarGrade({ gradeId, categories, locations, reload, onClose, onEditarVariacao }) {
  const toast = useToast();
  const arvore = ordenarCategoriasHierarquia(categories);
  const [g, setG] = useState(null);
  const [f, setF] = useState(null);
  const [lote, setLote] = useState({ preco_custo: '', preco_venda: '' });
  const [novos, setNovos] = useState({});
  const [localNovos, setLocalNovos] = useState('');
  const [salvando, setSalvando] = useState(false);
  const carregar = useCallback(() => api.get(`/grades/${gradeId}`).then((x) => { setG(x); setF({ nome: x.nome, categoria_id: x.categoria_id }); }).catch((err) => { toast.erro(err); onClose(); }), [gradeId, toast, onClose]);
  useEffect(() => { carregar(); }, [carregar]);
  if (!g) return <Modal titulo="Grade" onClose={onClose}><p className="muted">Carregando…</p></Modal>;

  async function executar(fn, msg) {
    setSalvando(true);
    try { setG(await fn()); toast.sucesso(msg); await reload(); } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  const salvarDados = (e) => { e.preventDefault(); executar(() => api.put(`/grades/${g.id}`, f), 'Grade salva (nomes das variações atualizados)'); };
  function precoEmLote(e) {
    e.preventDefault();
    const b = {};
    if (lote.preco_custo.trim()) b.preco_custo = parseNumero(lote.preco_custo);
    if (lote.preco_venda.trim()) b.preco_venda = parseNumero(lote.preco_venda);
    if (!Object.keys(b).length) return;
    executar(() => api.put(`/grades/${g.id}`, b), 'Preço aplicado em todas as variações').then(() => setLote({ preco_custo: '', preco_venda: '' }));
  }
  function adicionar(e) {
    e.preventDefault();
    const valores = Object.fromEntries(Object.entries(novos).map(([k, t]) => [k, separarValores(t)]).filter(([, l]) => l.length));
    if (!Object.keys(valores).length) return;
    executar(() => api.post(`/grades/${g.id}/valores`, { valores, location_id: localNovos || null }), 'Variações criadas').then(() => setNovos({}));
  }
  async function alternar(v) {
    try { await api.patch(`/products/${v.id}/status`, { ativo: !v.ativo }); await carregar(); await reload(); } catch (err) { toast.erro(err); }
  }

  return (
    <Modal titulo={`Grade: ${g.nome}`} subtitulo={`${g.variacoes.length} variação(ões) · ${g.atributos.map((a) => `${a.nome}: ${a.valores.join(', ')}`).join(' · ')}`} onClose={onClose} largura="extra">
      <div className="form-stack">
        <form className="form-grid" onSubmit={salvarDados}>
          <Field label="Nome base"><input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} maxLength={120} /></Field>
          <Field label="Categoria">
            <select value={f.categoria_id || ''} onChange={(e) => setF({ ...f, categoria_id: e.target.value })}>{arvore.map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.nivel)}{c.nome}</option>)}</select>
          </Field>
          <div style={{ alignSelf: 'end' }}><button type="submit" className="btn-primario" disabled={salvando}>Salvar</button></div>
        </form>

        <div className="tabela-wrap">
          <table className="tabela-cartoes grade-tabela">
            <thead><tr><th>Variação</th><th>Código</th><th>Código de barras</th><th className="num">Custo</th><th className="num">Venda</th><th className="num">Estoque</th><th /></tr></thead>
            <tbody>
              {g.variacoes.map((v) => (
                <tr key={v.id} style={{ opacity: v.ativo ? 1 : 0.5 }}>
                  <td><b>{rotuloVariacao(g.atributos, v.variacao)}</b>{!v.ativo && <span className="badge-inativo"> inativa</span>}</td>
                  <td>{v.codigo_interno}</td>
                  <td>{v.barcode}</td>
                  <td className="num">{brl(v.preco_custo)}</td>
                  <td className="num">{brl(v.preco_venda)}</td>
                  <td className="num">{qtd(v.saldo_total, v.unidade)}</td>
                  <td className="num lv-acoes-linha">
                    <button type="button" className="btn-link" onClick={() => onEditarVariacao(v.id)}>Editar</button>
                    <button type="button" className={`btn-link ${v.ativo ? 'perigo' : ''}`} onClick={() => alternar(v)}>{v.ativo ? 'Desativar' : 'Ativar'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form className="card form-stack" onSubmit={precoEmLote} style={{ margin: 0 }}>
          <b>Preço em todas as variações</b>
          <div className="form-grid">
            <Field label="Custo (R$)"><input inputMode="decimal" value={lote.preco_custo} onChange={(e) => setLote({ ...lote, preco_custo: e.target.value })} placeholder="manter" /></Field>
            <Field label="Venda (R$)"><input inputMode="decimal" value={lote.preco_venda} onChange={(e) => setLote({ ...lote, preco_venda: e.target.value })} placeholder="manter" /></Field>
            <div style={{ alignSelf: 'end' }}><button type="submit" disabled={salvando}>Aplicar</button></div>
          </div>
        </form>

        <form className="card form-stack" onSubmit={adicionar} style={{ margin: 0 }}>
          <b>Novos valores</b>
          <p className="form-hint" style={{ margin: 0 }}>Ex.: uma cor nova. O sistema cria as combinações com o valor novo (preço e fornecedor da primeira variação; estoque zerado ou na loja escolhida, depois é só dar entrada).</p>
          <div className="form-grid">
            {g.atributos.map((a) => (
              <Field key={a.nome} label={`${a.nome} (novos)`}><input value={novos[a.nome] || ''} onChange={(e) => setNovos({ ...novos, [a.nome]: e.target.value })} placeholder="separados por vírgula" /></Field>
            ))}
            <Field label="Loja do estoque">
              <select value={localNovos} onChange={(e) => setLocalNovos(e.target.value)}><option value="">—</option>{locations.filter((l) => l.ativo).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select>
            </Field>
            <div style={{ alignSelf: 'end' }}><button type="submit" disabled={salvando}>Criar variações</button></div>
          </div>
        </form>
      </div>
    </Modal>
  );
}

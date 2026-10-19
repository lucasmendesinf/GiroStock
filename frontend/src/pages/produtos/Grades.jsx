import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';
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

// ---------- produtos ja cadastrados -> grade ----------
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const podeAgrupar = (p) => !p.grade_id && !p.e_combo && !p.tem_ficha_tecnica;
const RE_TAMANHO = /^(pp|p|m|g|gg|xg|xgg|eg|egg|u|unico|[0-9]{1,2}|[0-9]{1,2}\/[0-9]{1,2})$/;
const RE_VOLTAGEM = /^(110|127|220|240)v?$|^bivolt$/;
const RE_CAPACIDADE = /^[0-9]+([,.][0-9]+)?(ml|l|g|kg|gb|tb|mah)$/;

// Sugestao a partir dos nomes: a parte comum vira o nome da grade e o resto, os valores
// ("Camiseta Básica Preta M" e "Camiseta Básica Branca G" -> "Camiseta Básica", Cor: Preta/Branca, Tamanho: M/G).
export function sugerirGrade(produtos) {
  const palavras = produtos.map((p) => p.nome.split(/\s+/).filter((w) => w && !/^[-/|]+$/.test(w)));
  let comum = 0;
  while (palavras.every((w) => comum < w.length - 1 && semAcento(w[comum]) === semAcento(palavras[0][comum]))) comum++;
  const nome = palavras[0].slice(0, comum).join(' ');
  const restos = palavras.map((w) => w.slice(comum));
  const n = restos[0].length;
  const colunas = n >= 1 && n <= MAX_ATRIBUTOS && restos.every((r) => r.length === n) ? n : 1;
  const valores = restos.map((r) => (colunas === n ? r : [r.join(' ')]));
  const usados = new Set();
  const atributos = Array.from({ length: colunas }, (_, i) => {
    const col = valores.map((v) => semAcento(v[i]));
    let a = col.every((v) => RE_TAMANHO.test(v)) ? 'Tamanho' : col.every((v) => RE_VOLTAGEM.test(v)) ? 'Voltagem' : col.every((v) => RE_CAPACIDADE.test(v)) ? 'Capacidade' : null;
    if (!a || usados.has(a)) a = ['Cor', 'Modelo', 'Sabor', 'Tipo'].find((x) => !usados.has(x));
    usados.add(a);
    return a;
  });
  return { nome, atributos, valores: Object.fromEntries(produtos.map((p, i) => [p.id, atributos.map((_, j) => valores[i][j] || '')])) };
}

export function ConverterGrade({ products, categories, reload, onClose, onSalvo }) {
  const toast = useToast();
  const arvore = ordenarCategoriasHierarquia(categories);
  const [etapa, setEtapa] = useState('escolher');
  const [busca, setBusca] = useState('');
  const [marcados, setMarcados] = useState([]);
  const [f, setF] = useState({ nome: '', categoria_id: '', renomear: true });
  const [atributos, setAtributos] = useState([]);
  const [valores, setValores] = useState({}); // product_id -> [valor por atributo]
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const candidatos = products.filter((p) => p.ativo && podeAgrupar(p));
  const t = semAcento(busca.trim());
  const visiveis = candidatos.filter((p) => !t || semAcento(p.nome).includes(t) || p.barcode.includes(busca.trim()) || semAcento(p.codigo_interno).includes(t)).slice(0, 80);
  const escolhidos = marcados.map((id) => products.find((p) => p.id === id)).filter(Boolean);
  const marcar = (id) => setMarcados(marcados.includes(id) ? marcados.filter((x) => x !== id) : [...marcados, id]);

  function montar() {
    setErro('');
    if (escolhidos.length < 2) return setErro('Marque ao menos 2 produtos.');
    if (new Set(escolhidos.map((p) => p.unidade)).size > 1) return setErro('Os produtos precisam ter a mesma unidade (UN, KG...).');
    const s = sugerirGrade(escolhidos);
    setF({ nome: s.nome, categoria_id: escolhidos[0].categoria_id || '', renomear: true });
    setAtributos(s.atributos);
    setValores(s.valores);
    setEtapa('montar');
  }
  const valor = (id, i) => (valores[id] || [])[i] || '';
  const mudarValor = (id, i, v) => setValores({ ...valores, [id]: atributos.map((_, j) => (j === i ? v : valor(id, j))) });
  const removerAtributo = (i) => {
    setAtributos(atributos.filter((_, j) => j !== i));
    setValores(Object.fromEntries(Object.entries(valores).map(([id, l]) => [id, l.filter((_, j) => j !== i)])));
  };
  const variacaoDe = (id) => Object.fromEntries(atributos.map((a, i) => [a.trim(), valor(id, i).trim()]));
  const novoNome = (id) => `${f.nome.trim()} - ${atributos.map((_, i) => valor(id, i).trim()).join(' - ')}`;
  const repetidas = useMemo(() => {
    const vistos = new Map();
    const r = new Set();
    for (const p of escolhidos) {
      const k = semAcento(JSON.stringify(atributos.map((_, i) => valor(p.id, i).trim())));
      if (vistos.has(k)) { r.add(p.id); r.add(vistos.get(k)); } else vistos.set(k, p.id);
    }
    return r;
  }, [valores, atributos, marcados]); // eslint-disable-line react-hooks/exhaustive-deps

  async function salvar(e) {
    e.preventDefault();
    setErro('');
    if (f.nome.trim().length < 3) return setErro('Informe o nome da grade (ex.: Camiseta Básica).');
    if (!f.categoria_id) return setErro('Escolha a categoria.');
    if (!atributos.length || atributos.some((a) => !a.trim())) return setErro('Dê nome a todos os atributos (ex.: Cor, Tamanho).');
    const faltando = escolhidos.find((p) => atributos.some((_, i) => !valor(p.id, i).trim()));
    if (faltando) return setErro(`Preencha os valores de "${faltando.nome}".`);
    if (repetidas.size) return setErro('Há produtos com a mesma variação (linhas em vermelho).');
    setSalvando(true);
    try {
      const g = await api.post('/grades/converter', {
        nome: f.nome.trim(), categoria_id: f.categoria_id, renomear: f.renomear,
        atributos: atributos.map((a) => ({ nome: a.trim() })),
        produtos: escolhidos.map((p) => ({ product_id: p.id, variacao: variacaoDe(p.id) })),
      });
      toast.sucesso(`Grade criada com ${g.variacoes.length} produtos${g.site_publicado ? ' (já publicada na loja virtual)' : ''}`);
      await reload();
      onSalvo(g);
    } catch (err) { setErro(err.message); toast.erro(err); } finally { setSalvando(false); }
  }

  if (etapa === 'escolher') {
    return (
      <Modal titulo="Agrupar produtos em grade" subtitulo="Escolha os produtos que são o mesmo item em cores, tamanhos ou voltagens diferentes. Estoque, código de barras, preço e histórico de vendas continuam os mesmos." onClose={onClose} largura="extra">
        <div className="form-stack">
          <input autoFocus className="toolbar-busca" style={{ maxWidth: 'none' }} value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Pesquisar (ex.: camiseta)" aria-label="Pesquisar produto" />
          <div className="tabela-wrap" style={{ maxHeight: 380, overflow: 'auto' }}>
            <table className="tabela-cartoes grade-tabela grade-escolher">
              <thead><tr><th /><th>Produto</th><th>Código</th><th>Un.</th><th className="num">Venda</th></tr></thead>
              <tbody>
                {visiveis.map((p) => (
                  <tr key={p.id} onClick={() => marcar(p.id)} style={{ cursor: 'pointer' }}>
                    <td><input type="checkbox" checked={marcados.includes(p.id)} onChange={() => marcar(p.id)} onClick={(e) => e.stopPropagation()} aria-label={`Escolher ${p.nome}`} /></td>
                    <td><b>{p.nome}</b><div className="celula-sub">{p.categoria_nome || 'Sem categoria'} · EAN {p.barcode}</div></td>
                    <td>{p.codigo_interno}</td>
                    <td>{p.unidade}</td>
                    <td className="num">{brl(p.preco_venda)}</td>
                  </tr>
                ))}
                {visiveis.length === 0 && <tr><td colSpan={5} className="muted">Nenhum produto avulso encontrado.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="form-hint" style={{ margin: 0 }}>Combos, lanches com ficha técnica e produtos que já estão em grade não aparecem aqui.</p>
          {erro && <div className="es-erro">{erro}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancelar</button>
            <button type="button" className="btn-primario" onClick={montar}>Continuar com {escolhidos.length} produto(s)</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal titulo="Agrupar produtos em grade" subtitulo="Confira o nome da grade e a variação de cada produto (sugeridos pelos nomes)." onClose={onClose} largura="extra">
      <form className="form-stack" onSubmit={salvar} noValidate>
        <div className="form-grid">
          <Field label="Nome da grade *" style={{ flexBasis: '100%' }}><input autoFocus value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder="Ex.: Camiseta Básica Algodão" maxLength={120} /></Field>
          <Field label="Categoria *">
            <select value={f.categoria_id} onChange={(e) => setF({ ...f, categoria_id: e.target.value })}>
              <option value="">Escolha...</option>
              {arvore.map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.nivel)}{c.nome}</option>)}
            </select>
          </Field>
          <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.renomear} onChange={(e) => setF({ ...f, renomear: e.target.checked })} /> Renomear os produtos no padrão da grade</label>
        </div>
        <div className="tabela-wrap" style={{ maxHeight: 400, overflow: 'auto' }}>
          <table className="tabela-cartoes grade-tabela grade-converter">
            <thead>
              <tr>
                <th>Produto atual</th>
                {atributos.map((a, i) => (
                  <th key={i}>
                    <span className="grade-th-atributo">
                      <input list="grade-sugestoes" value={a} onChange={(e) => setAtributos(atributos.map((x, j) => (j === i ? e.target.value : x)))} placeholder="Atributo" aria-label={`Atributo ${i + 1}`} maxLength={30} />
                      {atributos.length > 1 && <button type="button" className="grade-remover" onClick={() => removerAtributo(i)} aria-label="Remover atributo" title="Remover atributo">×</button>}
                    </span>
                  </th>
                ))}
                {atributos.length < MAX_ATRIBUTOS && <th><button type="button" className="btn-link" onClick={() => setAtributos([...atributos, ''])}>+ Atributo</button></th>}
              </tr>
            </thead>
            <tbody>
              {escolhidos.map((p) => (
                <tr key={p.id} className={repetidas.has(p.id) ? 'grade-linha-erro' : ''}>
                  <td><b>{p.nome}</b>{f.renomear && f.nome.trim() && <div className="celula-sub">vira: {novoNome(p.id)}</div>}</td>
                  {atributos.map((a, i) => (
                    <td key={i}><input value={valor(p.id, i)} onChange={(e) => mudarValor(p.id, i, e.target.value)} aria-label={`${a || 'Valor'} de ${p.nome}`} maxLength={30} /></td>
                  ))}
                  {atributos.length < MAX_ATRIBUTOS && <td />}
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="grade-sugestoes">{SUGESTOES.map((s) => <option key={s} value={s} />)}</datalist>
        </div>
        <p className="form-hint" style={{ margin: 0 }}>Na loja virtual, se algum desses produtos já estava publicado, a grade entra publicada e a foto de cada produto vira a foto do valor (ex.: a foto da camiseta preta vira a foto da cor Preta).</p>
        {erro && <div className="es-erro">{erro}</div>}
        <div className="modal-actions">
          <button type="button" onClick={() => setEtapa('escolher')}>Voltar</button>
          <button type="submit" className="btn-primario" disabled={salvando}>{salvando ? 'Agrupando...' : `Agrupar ${escolhidos.length} produtos`}</button>
        </div>
      </form>
    </Modal>
  );
}

// Grade existente: renomear, preco em lote, novos valores e as variacoes (cada uma abre a edicao normal do produto).
export function EditarGrade({ gradeId, products = [], categories, locations, reload, onClose, onEditarVariacao }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [inclusao, setInclusao] = useState({ product_id: '', valores: {} });
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
  const avulsos = products.filter((p) => p.ativo && podeAgrupar(p) && (!g.variacoes[0] || p.unidade === g.variacoes[0].unidade));
  function escolherInclusao(id) {
    const p = products.find((x) => x.id === id);
    // sugere os valores pela parte do nome que sobra depois do nome da grade
    const resto = p ? p.nome.split(/\s+/).filter((w) => !/^[-/|]+$/.test(w)).filter((w, i) => semAcento(w) !== semAcento(g.nome.split(/\s+/)[i])) : [];
    const sugestao = resto.length === g.atributos.length ? Object.fromEntries(g.atributos.map((a, i) => [a.nome, resto[i]])) : {};
    setInclusao({ product_id: id, valores: sugestao });
  }
  function incluir(e) {
    e.preventDefault();
    if (!inclusao.product_id) return;
    executar(() => api.post(`/grades/${g.id}/produtos`, { product_id: inclusao.product_id, variacao: inclusao.valores }), 'Produto incluído na grade').then(() => setInclusao({ product_id: '', valores: {} }));
  }
  async function retirar(v) {
    if (!(await confirmar({ titulo: `Tirar "${v.nome}" da grade?`, mensagem: 'Ele volta a ser um produto avulso, com o mesmo estoque e histórico.', confirmar: 'Tirar da grade' }))) return;
    try {
      const r = await api.del(`/grades/${g.id}/produtos/${v.id}`);
      toast.sucesso('Produto retirado da grade');
      await reload();
      if (r.grade_apagada) onClose(); else setG(r);
    } catch (err) { toast.erro(err); }
  }
  async function desfazer() {
    if (!(await confirmar({ titulo: `Desfazer a grade "${g.nome}"?`, mensagem: `As ${g.variacoes.length} variações voltam a ser produtos avulsos, com o mesmo nome, estoque e histórico. Na loja virtual, cada uma aparece separada.`, confirmar: 'Desfazer grade', perigo: true }))) return;
    try { await api.del(`/grades/${g.id}`); toast.sucesso('Grade desfeita'); await reload(); onClose(); } catch (err) { toast.erro(err); }
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
                    <button type="button" className="btn-link" onClick={() => retirar(v)} title="Volta a ser um produto avulso">Tirar</button>
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

        <form className="card form-stack" onSubmit={incluir} style={{ margin: 0 }}>
          <b>Incluir produto já cadastrado</b>
          <p className="form-hint" style={{ margin: 0 }}>Um produto avulso entra como variação (mantém estoque, código de barras e histórico). Valor novo entra sozinho na grade.</p>
          <div className="form-grid">
            <Field label="Produto">
              <select value={inclusao.product_id} onChange={(e) => escolherInclusao(e.target.value)}>
                <option value="">Escolha...</option>
                {avulsos.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
              </select>
            </Field>
            {inclusao.product_id && g.atributos.map((a) => (
              <Field key={a.nome} label={a.nome}><input list={`grade-valores-${a.nome}`} value={inclusao.valores[a.nome] || ''} onChange={(e) => setInclusao({ ...inclusao, valores: { ...inclusao.valores, [a.nome]: e.target.value } })} maxLength={30} />
                <datalist id={`grade-valores-${a.nome}`}>{a.valores.map((x) => <option key={x} value={x} />)}</datalist>
              </Field>
            ))}
            <div style={{ alignSelf: 'end' }}><button type="submit" disabled={salvando || !inclusao.product_id}>Incluir</button></div>
          </div>
        </form>

        <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="btn-link perigo" onClick={desfazer} title="As variações voltam a ser produtos avulsos">Desfazer grade</button>
          <button type="button" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </Modal>
  );
}

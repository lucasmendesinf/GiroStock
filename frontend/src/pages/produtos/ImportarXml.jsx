import { useRef, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import ProdutoPicker from '../../components/ProdutoPicker.jsx';
import { brl, parseNumero } from '../../utils/format';
import { lembrarLoja, ordenarCategoriasHierarquia, UNIDADES_PRODUTO } from './comum.jsx';

const CATEGORIAS_FORNECEDOR = ['Bebidas', 'Cigarros e Tabacaria', 'Alimentos e Insumos', 'Embalagens', 'Outros'];
const MARGEM_PADRAO = 1.3;
const MODOS = [
  { id: 'vincular', label: 'Vincular a produto' },
  { id: 'novo', label: 'Cadastrar novo' },
  { id: 'ignorar', label: 'Ignorar' },
];

// Tenta descobrir quantas unidades vem na caixa pela descricao ("6UN", "CX20", "FARDO 12", "C/12", "FL 06").
function unidadesNaCaixa(nome, unidade) {
  if (!/^(CX|CAIXA|FD|FARDO|PCT|PC)/i.test(unidade || '')) return 1;
  const t = String(nome || '').toUpperCase();
  const m = t.match(/(\d+)\s*(?:UN|UND|UNID|UNIDADES)\b/) || t.match(/\bCX\s*0*(\d+)\b/) || t.match(/\bC\/\s*(\d+)\b/)
    || t.match(/\bFARDO\s*(\d+)\b/) || t.match(/\bFL\s*0*(\d+)\b/);
  const n = m ? Number(m[1]) : 1;
  return n >= 1 && n <= 1000 ? n : 1;
}
const precoSugerido = (custoUn) => (Math.ceil(custoUn * MARGEM_PADRAO * 100) / 100).toFixed(2).replace('.', ',');

const soDigitos = (v) => String(v || '').replace(/\D/g, '');
const eanValido = (v) => { const d = soDigitos(v); return d.length >= 8 && d.length <= 14 ? d : ''; };
const paraCampo = (n) => String(Math.round(n * 10000) / 10000).replace('.', ',');
const unidadeDoProduto = (u) => {
  const x = String(u || '').toUpperCase();
  if (x.startsWith('CX')) return 'CX';
  if (x === 'KG') return 'KG';
  if (x === 'L' || x === 'LT') return 'L';
  return UNIDADES_PRODUTO.includes(x) ? x : 'UN';
};

// Le o XML da NF-e (procNFe/NFe) e devolve cabecalho, emitente e itens (GTIN/EAN = cEAN ou cEANTrib).
function lerNfe(texto) {
  const doc = new DOMParser().parseFromString(texto, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Arquivo XML inválido.');
  const tag = (el, nome) => { const n = el && el.getElementsByTagName(nome)[0]; return n ? n.textContent.trim() : ''; };
  const inf = doc.getElementsByTagName('infNFe')[0];
  if (!inf) throw new Error('Este XML não é uma NF-e (tag infNFe não encontrada).');
  const emit = inf.getElementsByTagName('emit')[0];
  const itens = [...inf.getElementsByTagName('det')].map((det) => {
    const prod = det.getElementsByTagName('prod')[0];
    const qCom = Number(tag(prod, 'qCom'));
    const vProd = Number(tag(prod, 'vProd'));
    return {
      cProd: tag(prod, 'cProd'), nome: tag(prod, 'xProd'), unidade: tag(prod, 'uCom'),
      eans: [eanValido(tag(prod, 'cEAN')), eanValido(tag(prod, 'cEANTrib'))].filter(Boolean),
      quantidade: qCom, custo: qCom > 0 ? Math.round((vProd / qCom) * 10000) / 10000 : 0,
    };
  });
  return {
    numero: tag(inf.getElementsByTagName('ide')[0], 'nNF'),
    emitente: tag(emit, 'xNome'), cnpj: soDigitos(tag(emit, 'CNPJ') || tag(emit, 'CPF')),
    fone: soDigitos(tag(emit, 'fone')), email: tag(emit, 'email'),
    itens,
  };
}

// Importacao de XML de NF-e na entrada por nota. O GTIN/EAN do item e a chave para achar o produto;
// quando nao acha, o item pode ser vinculado a um produto existente ou cadastrado como novo. O emitente
// com CNPJ desconhecido pode virar fornecedor novo. Nada e gravado antes da confirmacao.
export default function ImportarXml({ products, suppliers, locations, categories, locationId, onLancado }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [nota, setNota] = useState(null);
  const [linhas, setLinhas] = useState([]);
  const [loja, setLoja] = useState(locationId);
  const [categoriaId, setCategoriaId] = useState('');
  const [novoFornecedor, setNovoFornecedor] = useState({ cadastrar: true, nome: '', telefone: '', categoria: CATEGORIAS_FORNECEDOR[0] });
  const [salvando, setSalvando] = useState(false);
  const criados = useRef({ fornecedor: null, produtos: {} });
  const elegiveis = products.filter((p) => p.ativo && !p.tem_ficha_tecnica);

  function casar(item) {
    return elegiveis.find((p) => item.eans.includes(soDigitos(p.barcode)))
      || elegiveis.find((p) => item.cProd && String(p.codigo_interno).toLowerCase() === item.cProd.toLowerCase())
      || null;
  }

  async function abrir(e) {
    const arquivo = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!arquivo) return;
    try {
      const n = lerNfe(await arquivo.text());
      if (n.itens.length === 0) throw new Error('A nota não tem itens.');
      setLinhas(n.itens.map((l) => {
        const p = casar(l);
        return {
          ...l, chave: `${l.eans[0] || 'cod'}:${l.cProd}`,
          achadoPorEan: !!p, modo: p ? 'vincular' : 'novo', produtoId: p ? p.id : '',
          qtdTxt: paraCampo(l.quantidade), custoTxt: paraCampo(l.custo),
          barcode: l.eans[0] || '', nomeNovo: l.nome, vendaEditada: false,
          porCaixaTxt: String(unidadesNaCaixa(l.nome, l.unidade)),
          vendaTxt: precoSugerido(l.custo / unidadesNaCaixa(l.nome, l.unidade)),
        };
      }));
      setNota(n);
      setLoja(locationId);
      setNovoFornecedor({ cadastrar: true, nome: n.emitente, telefone: n.fone, categoria: CATEGORIAS_FORNECEDOR[0] });
      criados.current = { fornecedor: null, produtos: {} };
    } catch (err) { toast.erro(err); }
  }

  const atualizar = (i, campos) => setLinhas(linhas.map((l, k) => (k === i ? { ...l, ...campos } : l)));
  const fornecedor = nota && suppliers.find((s) => soDigitos(s.documento) === nota.cnpj);
  const lancaveis = linhas.filter((l) => l.modo !== 'ignorar');
  const novos = linhas.filter((l) => l.modo === 'novo');
  const ignorados = linhas.length - lancaveis.length;
  const total = lancaveis.reduce((s, l) => s + (parseNumero(l.qtdTxt) > 0 ? parseNumero(l.qtdTxt) * parseNumero(l.custoTxt) : 0), 0);
  const porCaixa = (l) => { const n = parseNumero(l.porCaixaTxt); return n >= 1 ? n : 1; };
  const qtdFinal = (l) => parseNumero(l.qtdTxt) * porCaixa(l);
  const custoFinal = (l) => parseNumero(l.custoTxt) / porCaixa(l);
  // Mudou caixa/custo: reajusta o preco de venda sugerido (se voce ainda nao mexeu nele).
  const mudar = (i, campos) => {
    const l = { ...linhas[i], ...campos };
    if (!l.vendaEditada && ('custoTxt' in campos || 'porCaixaTxt' in campos)) l.vendaTxt = precoSugerido(parseNumero(l.custoTxt) / porCaixa(l));
    atualizar(i, l);
  };
  const produtoDe = (id) => elegiveis.find((p) => p.id === id);

  function problema() {
    if (!loja) return 'Escolha a loja que recebe.';
    if (lancaveis.length === 0) return 'Nenhum item para lançar.';
    if (novos.length > 0 && !categoriaId) return 'Escolha a categoria dos produtos novos.';
    for (const l of lancaveis) {
      if (!(parseNumero(l.qtdTxt) > 0) || !(parseNumero(l.custoTxt) >= 0)) return `Confira a quantidade e o custo de "${l.nome}".`;
      if (!(parseNumero(l.porCaixaTxt) >= 1) || !Number.isInteger(parseNumero(l.porCaixaTxt))) return `"${l.nome}": unidades por caixa deve ser um número inteiro (1 se não vem em caixa).`;
      if (l.modo === 'vincular' && !l.produtoId) return `Escolha o produto para vincular a "${l.nome}" (ou cadastre como novo / ignore).`;
      if (l.modo === 'novo') {
        const custo = custoFinal(l);
        if (l.nomeNovo.trim().length < 3) return 'O nome do produto novo precisa ter ao menos 3 caracteres.';
        if (!eanValido(l.barcode)) return `Informe o código de barras (8 a 14 dígitos) de "${l.nomeNovo}".`;
        if (!(custo > 0)) return `"${l.nomeNovo}": o custo precisa ser maior que zero para cadastrar o produto.`;
        if (!(parseNumero(l.vendaTxt) > custo)) return `"${l.nomeNovo}": o preço de venda precisa ser maior que o custo.`;
      }
    }
    if (!fornecedor && nota.cnpj && novoFornecedor.cadastrar) {
      if (novoFornecedor.nome.trim().length < 2) return 'Informe o nome do fornecedor novo.';
      if (soDigitos(novoFornecedor.telefone).length < 10) return 'Informe o telefone do fornecedor novo (mínimo 10 dígitos).';
    }
    return '';
  }
  const aviso = nota ? problema() : '';

  async function confirmar() {
    setSalvando(true);
    try {
      let supplierId = fornecedor ? fornecedor.id : criados.current.fornecedor;
      if (!supplierId && novoFornecedor.cadastrar && nota.cnpj) {
        const s = await api.post('/suppliers', {
          nome: novoFornecedor.nome.trim(), documento: nota.cnpj, telefone: novoFornecedor.telefone,
          email: nota.email || undefined, categoria: novoFornecedor.categoria,
        });
        supplierId = s.id;
        criados.current.fornecedor = s.id;
      }
      // Itens que apontam para o mesmo produto viram uma linha so (soma das quantidades, custo medio).
      const porProduto = new Map();
      for (const l of lancaveis) {
        let productId = l.modo === 'vincular' ? l.produtoId : criados.current.produtos[l.chave];
        if (!productId) {
          const p = await api.post('/products', {
            nome: l.nomeNovo.trim(), categoria_id: categoriaId, unidade: porCaixa(l) > 1 ? 'UN' : unidadeDoProduto(l.unidade),
            barcode: eanValido(l.barcode), preco_custo: Math.round(custoFinal(l) * 100) / 100, preco_venda: parseNumero(l.vendaTxt),
            supplier_id: supplierId || null, supplier_ids: [], ficha_tecnica: [],
          });
          productId = p.id;
          criados.current.produtos[l.chave] = p.id;
        }
        const q = qtdFinal(l);
        const c = custoFinal(l);
        const ja = porProduto.get(productId);
        if (ja) {
          ja.custo_unitario = (ja.quantidade * ja.custo_unitario + q * c) / (ja.quantidade + q);
          ja.quantidade += q;
        } else porProduto.set(productId, { product_id: productId, quantidade: q, custo_unitario: c });
      }
      const r = await api.post('/stock-entries', {
        location_id: loja, supplier_id: supplierId || null, documento_fiscal: nota.numero, itens: [...porProduto.values()],
      });
      lembrarLoja(loja);
      toast.sucesso(`NF-e ${nota.numero} importada: ${r.itens} produto(s) (${novos.length} novo(s)), ${brl(r.valor_total)}.`);
      setNota(null);
      onLancado();
    } catch (err) {
      toast.erro(err);
      onLancado();
    } finally { setSalvando(false); }
  }

  return (
    <>
      <input ref={inputRef} type="file" accept=".xml,text/xml,application/xml" onChange={abrir} style={{ display: 'none' }} />
      <button type="button" className="es-btn-ghost" onClick={() => inputRef.current.click()} title="Importar o XML da nota fiscal (NF-e)">Importar XML da NF-e</button>
      {nota && (
        <Modal titulo="Conferir importação da NF-e" subtitulo={`Nota ${nota.numero || '—'} · ${nota.emitente || 'emitente não informado'}`} onClose={() => setNota(null)} largura="xml">
          <div className="form-stack" onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}>
            <div className="es-resumo">
              O <b>GTIN/EAN</b> de cada item é usado para achar o produto no cadastro. Itens não encontrados podem ser <b>vinculados</b> a um produto existente ou <b>cadastrados como novos</b>. Nada é gravado até você confirmar.
            </div>

            <div className="xml-secao">
              <div className="xml-secao-titulo">Fornecedor</div>
              {fornecedor && <div>Fornecedor já cadastrado (pelo CNPJ): <b>{fornecedor.nome}</b></div>}
              {!fornecedor && !nota.cnpj && <div className="muted">A nota não traz CNPJ do emitente: a entrada será lançada sem fornecedor.</div>}
              {!fornecedor && nota.cnpj && (
                <>
                  <label className="check">
                    <input type="checkbox" checked={novoFornecedor.cadastrar} onChange={(e) => setNovoFornecedor({ ...novoFornecedor, cadastrar: e.target.checked })} />
                    <span>Cadastrar <b>{nota.emitente || 'o emitente'}</b> (CNPJ {nota.cnpj}) como novo fornecedor e vincular aos produtos desta compra</span>
                  </label>
                  {novoFornecedor.cadastrar && (
                    <div className="xml-grid">
                      <Field label="Nome do fornecedor *"><input value={novoFornecedor.nome} onChange={(e) => setNovoFornecedor({ ...novoFornecedor, nome: e.target.value })} /></Field>
                      <Field label="Telefone *" hint={novoFornecedor.telefone ? undefined : 'A nota não trouxe telefone: informe.'}>
                        <input inputMode="tel" value={novoFornecedor.telefone} onChange={(e) => setNovoFornecedor({ ...novoFornecedor, telefone: e.target.value })} />
                      </Field>
                      <Field label="Categoria">
                        <select value={novoFornecedor.categoria} onChange={(e) => setNovoFornecedor({ ...novoFornecedor, categoria: e.target.value })}>
                          {CATEGORIAS_FORNECEDOR.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </Field>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="xml-secao">
              <div className="xml-secao-titulo">Destino do estoque</div>
              <div className="xml-grid">
                <Field label="Loja que recebe *">
                  <select value={loja} onChange={(e) => setLoja(e.target.value)}>
                    <option value="">Escolha...</option>
                    {locations.filter((l) => l.ativo).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
                  </select>
                </Field>
                {novos.length > 0 && (
                  <Field label="Categoria dos produtos novos *">
                    <select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}>
                      <option value="">Escolha...</option>
                      {ordenarCategoriasHierarquia(categories).map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.nivel)}{c.nome}</option>)}
                    </select>
                  </Field>
                )}
              </div>
            </div>

            <div className="xml-secao-titulo" style={{ marginBottom: '-4px' }}>Itens da nota ({linhas.length})</div>
            <div className="xml-itens">
              {linhas.map((l, i) => {
                const ativo = l.modo !== 'ignorar';
                const vinculado = produtoDe(l.produtoId);
                return (
                  <div key={i} className={`xml-item ${ativo ? '' : 'ignorado'}`}>
                    <div className="xml-item-topo">
                      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                        <div className="xml-item-nome">{l.nome}{l.achadoPorEan && <span className="xml-etiqueta">encontrado pelo EAN</span>}</div>
                        <div className="xml-item-sub">cód. {l.cProd} · {l.unidade}{l.eans[0] ? ` · GTIN ${l.eans[0]}` : ' · sem GTIN'}</div>
                      </div>
                      <div className="segmentado">
                        {MODOS.map((m) => (
                          <button key={m.id} type="button" className={l.modo === m.id ? 'ativo' : ''} onClick={() => atualizar(i, { modo: m.id })}>{m.label}</button>
                        ))}
                      </div>
                    </div>

                    {l.modo === 'vincular' && (
                      <div className="form-stack" style={{ gap: '6px' }}>
                        <ProdutoPicker produtos={elegiveis} valor={l.produtoId} onSelecionar={(p) => atualizar(i, { produtoId: p.id })}
                          placeholder="Buscar o produto do sistema por nome, código ou EAN" />
                        <div className="xml-vinculado">
                          {vinculado ? <>Vinculado a <b>{vinculado.nome}</b> ({vinculado.codigo_interno})</> : 'Nenhum produto escolhido: busque acima.'}
                        </div>
                      </div>
                    )}

                    {l.modo === 'novo' && (
                      <div className="xml-grid">
                        <Field label="Nome do produto novo *" className="span2"><input value={l.nomeNovo} onChange={(e) => atualizar(i, { nomeNovo: e.target.value })} /></Field>
                        <Field label="Código de barras *"><input inputMode="numeric" value={l.barcode} placeholder="8 a 14 dígitos" onChange={(e) => atualizar(i, { barcode: e.target.value })} /></Field>
                        <Field label="Preço de venda por unidade (R$) *" hint="Sugerido: custo + 30%"><input inputMode="decimal" value={l.vendaTxt} onChange={(e) => atualizar(i, { vendaTxt: e.target.value, vendaEditada: true })} /></Field>
                      </div>
                    )}

                    {ativo && (
                      <>
                        <div className="xml-grid">
                          <Field label={`Quantidade comprada (${l.unidade || 'un'}) *`}><input inputMode="decimal" value={l.qtdTxt} onChange={(e) => mudar(i, { qtdTxt: e.target.value })} /></Field>
                          <Field label="Unidades por caixa" hint="1 se o item não vem em caixa"><input inputMode="numeric" value={l.porCaixaTxt} onChange={(e) => mudar(i, { porCaixaTxt: e.target.value })} /></Field>
                          <Field label={`Custo por ${l.unidade || 'item'} da nota (R$) *`}><input inputMode="decimal" value={l.custoTxt} onChange={(e) => mudar(i, { custoTxt: e.target.value })} /></Field>
                          <Field label="Subtotal"><div style={{ padding: '10px 0', fontWeight: 700 }}>{parseNumero(l.qtdTxt) > 0 ? brl(parseNumero(l.qtdTxt) * parseNumero(l.custoTxt)) : '—'}</div></Field>
                        </div>
                        {porCaixa(l) > 1 && qtdFinal(l) > 0 && (
                          <div className="xml-calculo">Entram <b>{qtdFinal(l)} unidades</b> no estoque, a <b>{brl(custoFinal(l))}</b> cada.</div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="xml-totais">
              <span><b>{lancaveis.length}</b> item(ns) a lançar{novos.length > 0 && <> (<b>{novos.length}</b> novo(s))</>}{ignorados > 0 && <> · {ignorados} ignorado(s)</>} · Total: <b>{brl(total)}</b></span>
            </div>
            <div className="es-dica" style={{ marginTop: 0 }}>Se a nota vem em caixa, quantidade e custo são por caixa. Produto novo é criado na unidade da nota (caixa = CX).</div>
            {aviso && <div className="es-erro">{aviso}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => setNota(null)}>Cancelar</button>
              <button type="button" disabled={salvando || !!aviso} onClick={confirmar}>{salvando ? 'Lançando...' : 'Confirmar e lançar no estoque'}</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

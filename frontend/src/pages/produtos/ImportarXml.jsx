import { useRef, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { brl, parseNumero } from '../../utils/format';
import { lembrarLoja, ordenarCategoriasHierarquia, UNIDADES_PRODUTO } from './comum.jsx';

const CATEGORIAS_FORNECEDOR = ['Bebidas', 'Cigarros e Tabacaria', 'Alimentos e Insumos', 'Embalagens', 'Outros'];
const MARGEM_PADRAO = 1.3;

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

// Le o XML da NF-e (procNFe/NFe) e devolve cabecalho, emitente e itens.
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

// Importacao de XML de NF-e na entrada por nota. Itens que batem pelo codigo de barras (ou codigo PRD)
// recebem o saldo; os que nao existem sao cadastrados como produto novo, e o emitente que nao for
// um fornecedor cadastrado (pelo CNPJ) vira fornecedor novo. Nada e gravado antes da confirmacao.
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

  function casar(item) {
    const elegiveis = products.filter((p) => p.ativo && !p.tem_ficha_tecnica);
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
      // Mesmo produto em mais de uma linha da nota: soma as quantidades e faz a media do custo.
      const juntos = [];
      for (const it of n.itens) {
        const p = casar(it);
        const chave = it.eans[0] || `cod:${it.cProd}`;
        const ja = juntos.find((l) => (p ? l.produto && l.produto.id === p.id : !l.produto && l.chave === chave));
        if (ja) {
          const total = ja.qtd + it.quantidade;
          ja.custo = total > 0 ? (ja.qtd * ja.custo + it.quantidade * it.custo) / total : ja.custo;
          ja.qtd = total;
        } else juntos.push({ ...it, chave, produto: p, qtd: it.quantidade, custo: it.custo });
      }
      setLinhas(juntos.map((l) => ({
        ...l,
        qtdTxt: paraCampo(l.qtd), custoTxt: paraCampo(l.custo),
        cadastrar: !l.produto, barcode: l.eans[0] || '',
        nomeNovo: l.nome, vendaTxt: (Math.ceil(l.custo * MARGEM_PADRAO * 100) / 100).toFixed(2).replace('.', ','),
      })));
      setNota(n);
      setLoja(locationId);
      setNovoFornecedor({ cadastrar: true, nome: n.emitente, telefone: n.fone, categoria: CATEGORIAS_FORNECEDOR[0] });
      criados.current = { fornecedor: null, produtos: {} };
    } catch (err) { toast.erro(err); }
  }

  const atualizar = (i, campo, v) => setLinhas(linhas.map((l, k) => (k === i ? { ...l, [campo]: v } : l)));
  const fornecedor = nota && suppliers.find((s) => soDigitos(s.documento) === nota.cnpj);
  const lancaveis = linhas.filter((l) => l.produto || l.cadastrar);
  const novos = linhas.filter((l) => !l.produto && l.cadastrar);
  const ignorados = linhas.filter((l) => !l.produto && !l.cadastrar);
  const total = lancaveis.reduce((s, l) => s + (parseNumero(l.qtdTxt) > 0 ? parseNumero(l.qtdTxt) * parseNumero(l.custoTxt) : 0), 0);

  function problema() {
    if (!loja) return 'Escolha a loja que recebe.';
    if (lancaveis.length === 0) return 'Nenhum item para lançar.';
    if (lancaveis.some((l) => !(parseNumero(l.qtdTxt) > 0) || !(parseNumero(l.custoTxt) >= 0))) return 'Confira quantidade e custo dos itens.';
    if (novos.length > 0 && !categoriaId) return 'Escolha a categoria dos produtos novos.';
    for (const l of novos) {
      if (!eanValido(l.barcode)) return `Informe o código de barras (8 a 14 dígitos) de "${l.nomeNovo}".`;
      if (l.nomeNovo.trim().length < 3) return 'O nome do produto novo precisa ter ao menos 3 caracteres.';
      const custo = parseNumero(l.custoTxt);
      if (!(custo > 0)) return `"${l.nomeNovo}": o custo precisa ser maior que zero para cadastrar o produto.`;
      if (!(parseNumero(l.vendaTxt) > custo)) return `"${l.nomeNovo}": o preço de venda precisa ser maior que o custo.`;
    }
    if (!fornecedor && novoFornecedor.cadastrar) {
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
      const itens = [];
      for (const l of lancaveis) {
        let productId = l.produto ? l.produto.id : criados.current.produtos[l.chave];
        if (!productId) {
          const p = await api.post('/products', {
            nome: l.nomeNovo.trim(), categoria_id: categoriaId, unidade: unidadeDoProduto(l.unidade),
            barcode: eanValido(l.barcode), preco_custo: parseNumero(l.custoTxt), preco_venda: parseNumero(l.vendaTxt),
            supplier_id: supplierId || null, supplier_ids: [], ficha_tecnica: [],
          });
          productId = p.id;
          criados.current.produtos[l.chave] = p.id;
        }
        itens.push({ product_id: productId, quantidade: parseNumero(l.qtdTxt), custo_unitario: parseNumero(l.custoTxt) });
      }
      const r = await api.post('/stock-entries', {
        location_id: loja, supplier_id: supplierId || null, documento_fiscal: nota.numero, itens,
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
        <Modal titulo="Conferir importação da NF-e" subtitulo={`Nota ${nota.numero || '—'} · ${nota.emitente || 'emitente não informado'}`} onClose={() => setNota(null)} largura="extra">
          <div className="form-stack" onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}>
            <div className="es-resumo">
              {fornecedor
                ? <>Fornecedor: <b>{fornecedor.nome}</b> (já cadastrado, pelo CNPJ).</>
                : <>Fornecedor <b>{nota.emitente || 'sem nome'}</b> (CNPJ {nota.cnpj || 'não informado'}) ainda não está cadastrado.</>}
              {' '}Itens encontrados pelo <b>código de barras</b> recebem o saldo; os demais podem ser <b>cadastrados como produto novo</b>. Nada é gravado até você confirmar.
            </div>

            {!fornecedor && nota.cnpj && (
              <div className="card" style={{ marginBottom: 0 }}>
                <label className="check">
                  <input type="checkbox" checked={novoFornecedor.cadastrar} onChange={(e) => setNovoFornecedor({ ...novoFornecedor, cadastrar: e.target.checked })} />
                  Cadastrar como novo fornecedor e vincular aos produtos desta compra
                </label>
                {novoFornecedor.cadastrar && (
                  <div className="form-grid" style={{ marginTop: '10px' }}>
                    <Field label="Nome do fornecedor *"><input value={novoFornecedor.nome} onChange={(e) => setNovoFornecedor({ ...novoFornecedor, nome: e.target.value })} /></Field>
                    <Field label="Telefone *" hint={novoFornecedor.telefone ? undefined : 'A nota não trouxe telefone.'}>
                      <input inputMode="tel" value={novoFornecedor.telefone} onChange={(e) => setNovoFornecedor({ ...novoFornecedor, telefone: e.target.value })} />
                    </Field>
                    <Field label="Categoria">
                      <select value={novoFornecedor.categoria} onChange={(e) => setNovoFornecedor({ ...novoFornecedor, categoria: e.target.value })}>
                        {CATEGORIAS_FORNECEDOR.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </Field>
                  </div>
                )}
              </div>
            )}

            <div className="form-grid">
              <Field label="Loja que recebe *">
                <select value={loja} onChange={(e) => setLoja(e.target.value)}>
                  <option value="">Escolha...</option>
                  {locations.filter((l) => l.ativo).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
                </select>
              </Field>
              {linhas.some((l) => !l.produto) && (
                <Field label="Categoria dos produtos novos *">
                  <select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}>
                    <option value="">Escolha...</option>
                    {ordenarCategoriasHierarquia(categories).map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.nivel)}{c.nome}</option>)}
                  </select>
                </Field>
              )}
            </div>

            <div className="tabela-wrap">
              <table className="compacta">
                <thead><tr><th>Item da nota</th><th>No sistema</th><th className="num">Qtd</th><th className="num">Custo un. (R$)</th><th className="num">Venda (R$)</th><th className="num">Subtotal</th></tr></thead>
                <tbody>
                  {linhas.map((l, i) => {
                    const ativo = l.produto || l.cadastrar;
                    return (
                      <tr key={i} style={ativo ? undefined : { opacity: 0.55 }}>
                        <td>{l.nome}<div className="celula-sub">cód. {l.cProd} · {l.unidade}{l.eans[0] ? ` · EAN ${l.eans[0]}` : ''}</div></td>
                        <td>
                          {l.produto
                            ? <><b>{l.produto.nome}</b><div className="celula-sub">{l.produto.codigo_interno}</div></>
                            : (
                              <>
                                <label className="check" style={{ margin: 0 }}>
                                  <input type="checkbox" checked={l.cadastrar} onChange={(e) => atualizar(i, 'cadastrar', e.target.checked)} /> <span style={{ color: 'var(--warn)' }}>Cadastrar como novo</span>
                                </label>
                                {l.cadastrar && (
                                  <>
                                    <input aria-label="Nome do produto novo" value={l.nomeNovo} onChange={(e) => atualizar(i, 'nomeNovo', e.target.value)} style={{ marginTop: '6px' }} />
                                    {!l.eans[0] && <input aria-label="Código de barras" inputMode="numeric" placeholder="Código de barras (8 a 14 dígitos)" value={l.barcode} onChange={(e) => atualizar(i, 'barcode', e.target.value)} style={{ marginTop: '6px' }} />}
                                  </>
                                )}
                              </>
                            )}
                        </td>
                        <td className="num">{ativo ? <input className="es-min" inputMode="decimal" value={l.qtdTxt} onChange={(e) => atualizar(i, 'qtdTxt', e.target.value)} /> : '—'}</td>
                        <td className="num">{ativo ? <input className="es-min" inputMode="decimal" value={l.custoTxt} onChange={(e) => atualizar(i, 'custoTxt', e.target.value)} /> : '—'}</td>
                        <td className="num">{!l.produto && l.cadastrar ? <input className="es-min" inputMode="decimal" value={l.vendaTxt} onChange={(e) => atualizar(i, 'vendaTxt', e.target.value)} /> : '—'}</td>
                        <td className="num">{ativo && parseNumero(l.qtdTxt) > 0 ? brl(parseNumero(l.qtdTxt) * parseNumero(l.custoTxt)) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div>
              <b>{lancaveis.length}</b> produto(s) a lançar{novos.length > 0 && <> (<b>{novos.length}</b> novo(s))</>} · Total: <b>{brl(total)}</b>
              {ignorados.length > 0 && <> · <span style={{ color: 'var(--warn)' }}>{ignorados.length} item(ns) ignorado(s)</span></>}
            </div>
            <div className="es-dica" style={{ marginTop: 0 }}>O preço de venda dos produtos novos vem sugerido com 30% sobre o custo; ajuste antes de confirmar. Se a nota vem em caixa, a quantidade e o custo são por caixa.</div>
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

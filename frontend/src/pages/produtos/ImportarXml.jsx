import { useRef, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { brl, parseNumero } from '../../utils/format';
import { lembrarLoja } from './comum.jsx';

const soDigitos = (v) => String(v || '').replace(/\D/g, '');
const eanValido = (v) => { const d = soDigitos(v); return d.length >= 8 && d.length <= 14 ? d : ''; };

// Le o XML da NF-e (procNFe/NFe) e devolve cabecalho + itens.
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
    itens,
  };
}

const paraCampo = (n) => String(Math.round(n * 10000) / 10000).replace('.', ',');

// Importacao de XML de NF-e na entrada por nota: casa os itens pelo codigo de barras (ou codigo PRD),
// mostra uma tela de conferencia e so lanca o estoque depois da confirmacao.
export default function ImportarXml({ products, suppliers, locations, locationId, onLancado }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [nota, setNota] = useState(null);
  const [linhas, setLinhas] = useState([]);
  const [loja, setLoja] = useState(locationId);
  const [salvando, setSalvando] = useState(false);

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
        const ja = p && juntos.find((l) => l.produto && l.produto.id === p.id);
        if (ja) {
          const total = ja.qtd + it.quantidade;
          ja.custo = total > 0 ? (ja.qtd * ja.custo + it.quantidade * it.custo) / total : ja.custo;
          ja.qtd = total;
        } else juntos.push({ ...it, produto: p, qtd: it.quantidade, custo: it.custo });
      }
      setLinhas(juntos.map((l) => ({ ...l, qtdTxt: paraCampo(l.qtd), custoTxt: paraCampo(l.custo) })));
      setNota(n);
      setLoja(locationId);
    } catch (err) { toast.erro(err); }
  }

  const atualizar = (i, campo, v) => setLinhas(linhas.map((l, k) => (k === i ? { ...l, [campo]: v } : l)));
  const fornecedor = nota && suppliers.find((s) => soDigitos(s.documento) === nota.cnpj);
  const aLancar = linhas.filter((l) => l.produto);
  const ignorados = linhas.filter((l) => !l.produto);
  const total = aLancar.reduce((s, l) => s + (parseNumero(l.qtdTxt) > 0 ? parseNumero(l.qtdTxt) * parseNumero(l.custoTxt) : 0), 0);
  const invalido = aLancar.some((l) => !(parseNumero(l.qtdTxt) > 0) || !(parseNumero(l.custoTxt) >= 0));

  async function confirmar() {
    setSalvando(true);
    try {
      const r = await api.post('/stock-entries', {
        location_id: loja,
        supplier_id: fornecedor ? fornecedor.id : null,
        documento_fiscal: nota.numero,
        itens: aLancar.map((l) => ({ product_id: l.produto.id, quantidade: parseNumero(l.qtdTxt), custo_unitario: parseNumero(l.custoTxt) })),
      });
      lembrarLoja(loja);
      toast.sucesso(`NF-e ${nota.numero} importada: ${r.itens} produto(s), ${brl(r.valor_total)}.`);
      setNota(null);
      onLancado();
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }

  return (
    <>
      <input ref={inputRef} type="file" accept=".xml,text/xml,application/xml" onChange={abrir} style={{ display: 'none' }} />
      <button type="button" className="es-btn-ghost" onClick={() => inputRef.current.click()} title="Importar o XML da nota fiscal (NF-e)">Importar XML da NF-e</button>
      {nota && (
        <Modal titulo="Conferir importação da NF-e" subtitulo={`Nota ${nota.numero || '—'} · ${nota.emitente || 'emitente não informado'}`} onClose={() => setNota(null)} largura="extra">
          <div className="form-stack" onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}>
            <div className="es-resumo">
              Fornecedor: <b>{fornecedor ? fornecedor.nome : 'não cadastrado'}</b>{!fornecedor && nota.cnpj ? ` (CNPJ ${nota.cnpj}) — a entrada será lançada sem fornecedor` : ''}.
              Os produtos foram encontrados pelo <b>código de barras</b>. Confira as quantidades: nada é lançado até você confirmar.
            </div>
            <Field label="Loja que recebe *">
              <select value={loja} onChange={(e) => setLoja(e.target.value)}>
                <option value="">Escolha...</option>
                {locations.filter((l) => l.ativo).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
              </select>
            </Field>
            <div className="tabela-wrap">
              <table className="compacta">
                <thead><tr><th>Item da nota</th><th>Produto no sistema</th><th className="num">Qtd</th><th className="num">Custo un. (R$)</th><th className="num">Subtotal</th></tr></thead>
                <tbody>
                  {linhas.map((l, i) => (
                    <tr key={i} style={l.produto ? undefined : { opacity: 0.6 }}>
                      <td>{l.nome}<div className="celula-sub">cód. {l.cProd} · {l.unidade}{l.eans[0] ? ` · EAN ${l.eans[0]}` : ''}</div></td>
                      <td>{l.produto ? <><b>{l.produto.nome}</b><div className="celula-sub">{l.produto.codigo_interno}</div></> : <span style={{ color: 'var(--warn)' }}>não encontrado — será ignorado</span>}</td>
                      <td className="num">{l.produto ? <input className="es-min" inputMode="decimal" value={l.qtdTxt} onChange={(e) => atualizar(i, 'qtdTxt', e.target.value)} /> : '—'}</td>
                      <td className="num">{l.produto ? <input className="es-min" inputMode="decimal" value={l.custoTxt} onChange={(e) => atualizar(i, 'custoTxt', e.target.value)} /> : '—'}</td>
                      <td className="num">{l.produto && parseNumero(l.qtdTxt) > 0 ? brl(parseNumero(l.qtdTxt) * parseNumero(l.custoTxt)) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <b>{aLancar.length}</b> produto(s) a lançar · Total: <b>{brl(total)}</b>
              {ignorados.length > 0 && <> · <span style={{ color: 'var(--warn)' }}>{ignorados.length} item(ns) sem cadastro (cadastre o produto com o mesmo código de barras e importe de novo)</span></>}
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setNota(null)}>Cancelar</button>
              <button type="button" disabled={salvando || !loja || aLancar.length === 0 || invalido} onClick={confirmar}>{salvando ? 'Lançando...' : 'Confirmar e lançar no estoque'}</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

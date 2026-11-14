import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Field } from '../../components/ui.jsx';
import ProdutoPicker from '../../components/ProdutoPicker.jsx';
import { brl, parseNumero } from '../../utils/format';
import { aCentavos, indicadoresCombo, linhasDoCombo, nivelDaMargem, precoSugeridoCent } from '../../utils/precoCombo';

// Custo do combo = soma (custo do componente x quantidade).
export function custoDoCombo(itens, produtos) {
  return linhasDoCombo(itens, produtos).reduce((s, l) => s + l.custoCent, 0) / 100;
}

// Soma dos precos avulsos (preco de venda padrao x quantidade), em centavos.
export function avulsoDoComboCent(itens, produtos) {
  return linhasDoCombo(itens, produtos).reduce((s, l) => s + l.avulsoCent, 0);
}

// Margem e ",90" padrao dos combos: vem de "Dados da empresa" (qualquer usuario que cadastra produto le; so Configuracoes edita).
export function useCombosEmpresa() {
  const [cfg, setCfg] = useState({ margem: 30, final90: true });
  useEffect(() => {
    let vivo = true;
    api.get('/empresa').then((e) => { if (vivo) setCfg({ margem: Number(e.combo_margem_pct ?? 30), final90: e.combo_preco_final_90 !== false }); }).catch(() => {});
    return () => { vivo = false; };
  }, []);
  return cfg;
}

const reaisParaCampo = (cent) => (cent / 100).toFixed(2).replace('.', ',');
const pc1 = (v) => (v === null || !Number.isFinite(v) ? '—' : `${(Math.round(v * 10) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);

// Componentes do combo: produtos (revenda ou lanche) com quantidade, mostrando custo e preco avulso de CADA um. Combo dentro de combo nao existe.
// O preco avulso usa o preco de venda PADRAO do produto (pode haver preco por loja).
export function ComboEditor({ itens, setItens, produtos, proprioId }) {
  const elegiveis = produtos.filter((p) => p.ativo && !p.e_combo && p.id !== proprioId && !itens.some((i) => i.product_id === p.id));
  const linhas = linhasDoCombo(itens, produtos);
  const totalCusto = linhas.reduce((s, l) => s + l.custoCent, 0);
  const totalAvulso = linhas.reduce((s, l) => s + l.avulsoCent, 0);
  const margemAvulsaTotal = totalAvulso > 0 ? ((totalAvulso - totalCusto) / totalAvulso) * 100 : null;
  const [aviso, setAviso] = useState('');
  return (
    <div className="form-stack extras-bloco cb-bloco">
      <div className="es-titulo" style={{ marginBottom: 0 }}>Produtos do combo</div>
      <p className="form-hint" style={{ marginTop: 4 }}>O combo <b>não tem estoque próprio</b>: cada venda baixa os produtos abaixo (o estoque da revenda e os insumos dos lanches). Cada produto mantém o <b>seu próprio código</b>; aqui você vê quanto cada um custa e vale separadamente. O preço avulso é o preço de venda <b>padrão</b> do produto (pode haver preço por loja). Para deixar o cliente escolher a bebida, crie um grupo de complementos (ex.: "Escolha a bebida", mínimo 1, máximo 1) e marque abaixo.</p>
      {linhas.length > 0 && (
        <div className="tabela-wrap cb-tabela"><table className="compacta">
          <thead><tr><th>Produto</th><th>Código</th><th className="num">Qtd.</th><th className="num">Custo unit.</th><th className="num">Custo (qtd × unit.)</th><th className="num">Avulso unit.</th><th className="num">Avulso (qtd ×)</th><th className="num">Margem avulso</th><th /></tr></thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.product_id}>
                <td><b>{l.produto.nome || 'produto'}</b>{l.produto.tem_ficha_tecnica && <span className="celula-sub"> lanche (insumos)</span>}</td>
                <td className="cb-cod">{l.produto.codigo_interno}<div className="celula-sub">{l.produto.barcode}</div></td>
                <td className="num"><input className="es-min" inputMode="decimal" aria-label={`Quantidade de ${l.produto.nome}`} defaultValue={String(l.quantidade).replace('.', ',')}
                  onChange={(e) => { const q = parseNumero(e.target.value); if (q > 0) setItens(itens.map((x) => (x.product_id === l.product_id ? { ...x, quantidade: q } : x))); }} /></td>
                <td className="num">{brl(l.custoUn / 100)}</td>
                <td className="num"><b>{brl(l.custoCent / 100)}</b></td>
                <td className="num">{brl(l.vendaUn / 100)}</td>
                <td className="num">{brl(l.avulsoCent / 100)}</td>
                <td className="num">{pc1(l.margemAvulsa)}</td>
                <td className="num"><button type="button" className="btn-link perigo" onClick={() => setItens(itens.filter((x) => x.product_id !== l.product_id))}>Remover</button></td>
              </tr>
            ))}
            <tr className="cb-total"><td colSpan={4} className="num"><b>Total dos produtos</b></td><td className="num"><b>{brl(totalCusto / 100)}</b></td><td /><td className="num"><b>{brl(totalAvulso / 100)}</b></td><td className="num"><b>{pc1(margemAvulsaTotal)}</b></td><td /></tr>
          </tbody>
        </table></div>
      )}
      <Field label="Adicionar produto ao combo">
        <ProdutoPicker produtos={elegiveis} onSelecionar={(p) => { setItens([...itens, { product_id: p.id, quantidade: 1 }]); setAviso(`Adicionado: ${p.nome} · custo ${brl(p.preco_custo)}`); }} limparAoSelecionar placeholder="Buscar produto (nome, código ou código de barras)" />
      </Field>
      {aviso && <p className="form-hint" role="status">{aviso}</p>}
    </div>
  );
}

function eanDigitoOk(c) { let s = 0; for (let i = 0; i < 12; i++) s += Number(c[i]) * (i % 2 === 0 ? 1 : 3); return (10 - (s % 10)) % 10 === Number(c[12]); }

// Codigo de barras do COMBO. Novo: sugerido pelo servidor (EAN-13 interno, prefixo 2) com "Gerar outro" ou digitado. Editando: travado.
export function CodigoCombo({ valor, setValor, automatico, setAutomatico, editando, podeTrocar }) {
  const [gerando, setGerando] = useState(false);
  const [destravado, setDestravado] = useState(false);
  async function gerar() {
    setGerando(true);
    try { const r = await api.get('/products/codigo-barras-livre'); setValor(r.codigo); setAutomatico(true); } catch { /* se ficar vazio, o servidor gera ao salvar */ } finally { setGerando(false); }
  }
  useEffect(() => { if (!editando && !valor) gerar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const d = String(valor || '').replace(/\D/g, '');
  const ok = d.length === 13 ? eanDigitoOk(d) : d.length >= 8 && d.length <= 14;
  if (editando && !destravado) {
    return (
      <Field label="Código de barras do combo" hint="O código é gerado só no cadastro e não muda ao editar.">
        <div className="cb-codigo travado"><input value={valor} readOnly aria-label="Código de barras do combo" /><span className="ped-tag">🔒 fixo</span>
          {podeTrocar && <button type="button" className="btn-link" onClick={() => setDestravado(true)}>Trocar manualmente</button>}</div>
      </Field>
    );
  }
  return (
    <Field label="Código de barras do combo *" hint={d.length === 0 ? 'Gerando…' : ok ? (automatico ? '✔ Código válido · gerado automaticamente (EAN-13 interno, começa com 2). Pode digitar outro.' : '✔ Formato válido') : `8 a 14 dígitos numéricos${d.length === 13 ? ' (o dígito verificador não confere)' : ''}`}>
      <div className="cb-codigo"><input inputMode="numeric" value={valor} onChange={(e) => { setValor(e.target.value.replace(/\D/g, '').slice(0, 14)); setAutomatico(false); }} aria-label="Código de barras do combo" />
        {!editando && <button type="button" className="btn-link" disabled={gerando} onClick={gerar}>↻ Gerar outro</button>}</div>
    </Field>
  );
}

// Preco do combo: sugerido a partir do custo e da margem desejada; o valor e editavel e mostra margem, markup, lucro e desconto ao vivo.
// estado = { margem: '30', final90: true, auto: true } (guardado no formulario); vendaTexto/setVendaTexto = campo "preco_venda" do formulario.
export function PrecoCombo({ custoCent, avulsoCent, estado, setEstado, vendaTexto, setVendaTexto }) {
  const margemNum = parseNumero(estado.margem);
  const sug = precoSugeridoCent(custoCent, margemNum, estado.final90);
  useEffect(() => { if (estado.auto && sug !== null) { const t = reaisParaCampo(sug); if (t !== vendaTexto) setVendaTexto(t); } }, [estado.auto, sug]); // eslint-disable-line react-hooks/exhaustive-deps
  const precoCent = aCentavos(parseNumero(vendaTexto));
  const ind = indicadoresCombo({ custoCent, precoCent, avulsoCent });
  const nivel = nivelDaMargem(ind.margemPct, margemNum, precoCent, custoCent);
  return (
    <div className="form-stack extras-bloco cb-bloco">
      <div className="es-titulo" style={{ marginBottom: 0 }}>Preço do combo</div>
      <p className="form-hint" style={{ marginTop: 4 }}>O sistema sugere o preço a partir do custo e da margem desejada (sobre o preço de venda). Você pode mexer no valor e ver a margem na hora.</p>
      <div className="cb-preco-grade">
        <Field label="Margem desejada (%)" hint="Vem de Dados da empresa; mudar aqui vale só para este combo.">
          <input inputMode="decimal" value={estado.margem} onChange={(e) => setEstado({ ...estado, margem: e.target.value })} />
        </Field>
        <div className="cb-sugerido"><span className="cb-rotulo">Preço sugerido</span><b>{sug === null ? '—' : brl(sug / 100)}</b><small>custo ÷ (1 − margem){estado.final90 ? ' · termina em ,90' : ''}</small></div>
        <Field label="Preço de venda do combo (R$) *" hint={estado.auto ? 'acompanha o sugerido — se mexer, deixa de acompanhar' : `valor manual${sug !== null ? ` · sugerido: ${brl(sug / 100)}` : ''}`}>
          <input inputMode="decimal" value={vendaTexto} onChange={(e) => { setEstado({ ...estado, auto: false }); setVendaTexto(e.target.value); }} placeholder="0,00" />
        </Field>
        <div className="cb-acoes">
          <button type="button" className="btn-link" disabled={estado.auto || sug === null} onClick={() => setEstado({ ...estado, auto: true })}>Usar o sugerido</button>
          <label className="check"><input type="checkbox" checked={estado.final90} onChange={(e) => setEstado({ ...estado, final90: e.target.checked })} /> Terminar em ,90</label>
        </div>
      </div>
      <div className="cb-stats">
        <div className="cb-stat"><small>Custo do combo</small><b>{brl(custoCent / 100)}</b></div>
        <div className="cb-stat"><small>Lucro por combo</small><b className={ind.lucroCent > 0 ? 'ok' : 'ruim'}>{brl(ind.lucroCent / 100)}</b></div>
        <div className="cb-stat"><small>Margem (sobre a venda)</small><b className={nivel}>{precoCent > 0 ? pc1(ind.margemPct) : '—'}</b><span>markup sobre o custo: {custoCent > 0 && precoCent > 0 ? pc1(ind.markupPct) : '—'}</span></div>
        <div className="cb-stat"><small>Desconto sobre o avulso</small><b>{precoCent > 0 && avulsoCent > 0 ? pc1(ind.descontoPct) : '—'}</b><span>avulso somado: {brl(avulsoCent / 100)}</span></div>
      </div>
      <div className="cb-barra"><i className={nivel} style={{ width: `${Math.max(0, Math.min(100, ((ind.margemPct || 0) / 60) * 100))}%` }} /></div>
      <p className="form-hint" role="status">
        {precoCent > 0 && precoCent <= custoCent ? <span className="cb-erro">⚠ O preço está abaixo ou igual ao custo: o combo dá prejuízo.</span>
          : nivel === 'atencao' && sug !== null ? <>Margem abaixo dos <b>{String(estado.margem).replace('.', ',')}%</b> desejados — faltam <b>{brl(Math.max(0, sug - precoCent) / 100)}</b> para chegar na margem desejada.</>
            : precoCent > custoCent ? 'Margem dentro do desejado.' : ''}
      </p>
    </div>
  );
}

// Grupos de complementos que o produto oferece (PDV, pedidos e iFood).
export function GruposDoProduto({ selecionados, setSelecionados }) {
  const [grupos, setGrupos] = useState(null);
  useEffect(() => { api.get('/complement-groups').then(setGrupos).catch(() => setGrupos([])); }, []);
  if (!grupos) return null;
  const ativos = grupos.filter((g) => g.ativo || selecionados.includes(g.id));
  return (
    <div className="form-stack extras-bloco">
      <div className="es-titulo" style={{ marginBottom: 0 }}>Complementos (adicionais e escolhas)</div>
      {ativos.length === 0 ? (
        <p className="form-hint">Nenhum grupo de complementos cadastrado. Crie na aba <b>Complementos</b> (ex.: "Adicionais": Bacon extra, Cheddar).</p>
      ) : (
        <div className="grupos-produto">
          {ativos.map((g) => (
            <label key={g.id} className="check">
              <input type="checkbox" checked={selecionados.includes(g.id)}
                onChange={(e) => setSelecionados(e.target.checked ? [...selecionados, g.id] : selecionados.filter((x) => x !== g.id))} />
              <span><b>{g.nome}</b> <span className="muted">· {g.minimo > 0 ? `obrigatório (${g.minimo}${g.maximo > g.minimo ? ` a ${g.maximo}` : ''})` : `até ${g.maximo}`} · {g.opcoes.filter((o) => o.ativo).map((o) => o.nome).join(', ') || 'sem opções'}</span></span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// iFood: vender no iFood (o GiroStock pausa/reativa conforme o estoque) e o codigo PDV usado no cardapio do iFood.
export function CamposIfood({ valor, setValor, codigoInterno }) {
  return (
    <div className="form-stack extras-bloco ifood-bloco">
      <div className="es-titulo" style={{ marginBottom: 0 }}><span className="ped-tag ifood">iFood</span> Cardápio do iFood</div>
      <label className="check" style={{ marginTop: 6 }}>
        <input type="checkbox" checked={valor.vende_ifood} onChange={(e) => setValor({ ...valor, vende_ifood: e.target.checked })} />
        Vender no iFood — o GiroStock pausa o item no iFood quando acabar o estoque (ou um insumo) e reativa quando voltar
      </label>
      <Field label="Código PDV no iFood" hint={`Cadastre este mesmo código no item do cardápio do iFood. Vazio = ${codigoInterno || 'o código interno do produto (PRD-…)'}.`}>
        <input value={valor.codigo_ifood} onChange={(e) => setValor({ ...valor, codigo_ifood: e.target.value.toUpperCase() })} placeholder={codigoInterno || 'PRD-0000'} maxLength={60} />
      </Field>
    </div>
  );
}

import { useState } from 'react';
import { Field } from '../../components/ui.jsx';
import { brl, parseNumero } from '../../utils/format';

// Preco por loja e desconto por quantidade (pack/atacado) no cadastro do produto.
// estado: { porLoja, lojas: { [locationId]: { preco: '', vende: true } }, faixas: { geral: [F], [locationId]?: [F] } }
// F = { rotulo, quantidade_minima, modo: 'unitario' | 'kit' | 'percentual', valor: '8,00', automatica, ean_pack }
// As regras e mensagens repetem as do servidor (services/precos.js), que continua sendo a verdade.

const cent = (v) => Math.round(Number(v) * 100 + (Number(v) >= 0 ? 1e-7 : -1e-7));
const num = (s) => { const n = parseNumero(s); return Number.isFinite(n) ? n : 0; };
const virg = (n) => String(n).replace('.', ',');
const MODOS = [['unitario', 'Preço por unidade'], ['kit', 'Preço do kit'], ['percentual', '% de desconto']];
const margemDe = (preco, custo) => (preco > 0 ? ((preco - custo) / preco) * 100 : null);
const pctTxt = (m) => (m === null || !Number.isFinite(m) ? '—' : `${m.toFixed(1).replace('.', ',')}%`);

export const estadoInicialPrecos = () => ({ porLoja: false, lojas: {}, faixas: { geral: [] } });
export const faixaNova = (q = 6) => ({ rotulo: '', quantidade_minima: q, modo: 'percentual', valor: '5', automatica: true, ean_pack: '' });

// GET /products/:id -> estado da tela
export function precosDoServidor(d) {
  const lojas = {};
  let porLoja = false;
  for (const l of d.precos_lojas || []) {
    if (l.preco_venda !== null || !l.vende) { lojas[l.location_id] = { preco: l.preco_venda === null ? '' : virg(l.preco_venda), vende: l.vende }; porLoja = true; }
  }
  const faixas = { geral: [] };
  for (const f of d.faixas || []) {
    const item = { rotulo: f.rotulo, quantidade_minima: f.quantidade_minima, modo: f.modo_cadastro, valor: virg(f.valor_cadastro !== null && f.valor_cadastro !== undefined ? f.valor_cadastro : f.preco_unitario), automatica: f.automatica, ean_pack: f.ean_pack || '' };
    if (f.location_id) { (faixas[f.location_id] = faixas[f.location_id] || []).push(item); porLoja = true; } else faixas.geral.push(item);
  }
  return { porLoja, lojas, faixas };
}

// estado da tela -> corpo da API (precos_lojas + faixas)
export function payloadDePrecos(e, locais) {
  const ids = new Set(locais.map((l) => l.id));
  const precos_lojas = e.porLoja
    ? locais.map((l) => { const r = e.lojas[l.id] || {}; return { location_id: l.id, preco_venda: r.preco === undefined || String(r.preco).trim() === '' ? null : num(r.preco), vende: r.vende !== false }; })
      .filter((r) => r.preco_venda !== null || !r.vende)
    : [];
  const faixas = [];
  const add = (lista, location_id) => (lista || []).forEach((f) => faixas.push({
    location_id, rotulo: String(f.rotulo || '').trim(), quantidade_minima: Number(f.quantidade_minima), modo_cadastro: f.modo,
    valor_cadastro: num(f.valor), automatica: f.automatica !== false, ean_pack: String(f.ean_pack || '').trim() || null,
  }));
  add(e.faixas.geral, null);
  if (e.porLoja) for (const id of Object.keys(e.faixas)) if (id !== 'geral' && ids.has(id) && e.faixas[id]) add(e.faixas[id], id);
  return { precos_lojas, faixas };
}

// Preco unitario (em reais) de uma faixa a partir de como foi informada; erro = mensagem de validacao.
export function calcFaixa(f, precoLoja) {
  const q = Number(f.quantidade_minima);
  const v = num(f.valor);
  if (!(v > 0)) return { unit: null, erro: 'informe o valor da faixa' };
  if (f.modo === 'kit') {
    const total = cent(v);
    if (!(q >= 2)) return { unit: null, erro: 'informe a quantidade mínima' };
    if (total % q !== 0) return { unit: null, erro: `o kit de ${q} un por ${brl(total / 100)} não divide em centavos exatos` };
    return { unit: total / q / 100 };
  }
  if (f.modo === 'percentual') {
    if (!(v < 100)) return { unit: null, erro: 'o desconto precisa ser menor que 100%' };
    return { unit: Math.round(cent(precoLoja) * (1 - v / 100)) / 100 };
  }
  return { unit: cent(v) / 100 };
}

// Troca o "informar por" sem perder o resultado (o valor se converte para o novo modo).
function converterModo(f, novo, precoLoja) {
  const { unit } = calcFaixa(f, precoLoja);
  if (unit === null || unit === undefined) return { ...f, modo: novo };
  const q = Number(f.quantidade_minima);
  const v = novo === 'unitario' ? unit.toFixed(2) : novo === 'kit' ? (unit * q).toFixed(2) : String(Math.round((1 - unit / precoLoja) * 10000) / 100);
  return { ...f, modo: novo, valor: virg(v) };
}

function alertasDaFaixa(f, lista, precoLoja, custo) {
  const a = [];
  const { unit, erro } = calcFaixa(f, precoLoja);
  if (erro) a.push({ t: 'err', txt: erro });
  if (!(Number(f.quantidade_minima) >= 2) || !Number.isInteger(Number(f.quantidade_minima))) a.push({ t: 'err', txt: 'a quantidade mínima é um número inteiro a partir de 2' });
  if (unit !== null && unit !== undefined) {
    if (unit >= precoLoja) a.push({ t: 'err', txt: 'o preço da faixa não é menor que o preço unitário' });
    if (custo > 0 && unit <= custo) a.push({ t: 'err', txt: 'abaixo do custo (permitido, mas confira)' });
    else if (custo > 0 && margemDe(unit, custo) < 10) a.push({ t: 'warn', txt: 'margem baixa (menos de 10%)' });
  }
  if (lista.filter((x) => Number(x.quantidade_minima) === Number(f.quantidade_minima)).length > 1) a.push({ t: 'err', txt: 'quantidade repetida' });
  return a;
}

// Primeiro erro que impede salvar (o servidor confere de novo). 'abaixo do custo' so alerta.
export function validarPrecos(e, locais, venda) {
  const nomeDe = (id) => (locais.find((l) => l.id === id) || {}).nome || 'loja';
  const grupos = [['geral', 'Faixas padrão', venda]];
  if (e.porLoja) for (const l of locais.filter((x) => x.ativo)) {
    const r = e.lojas[l.id] || {};
    const preco = String(r.preco || '').trim() === '' ? venda : num(r.preco);
    if (String(r.preco || '').trim() !== '' && !(num(r.preco) > 0)) return `Preço inválido em ${nomeDe(l.id)}.`;
    if (e.faixas[l.id]) grupos.push([l.id, `Faixas de ${nomeDe(l.id)}`, preco]);
  }
  for (const [id, titulo, preco] of grupos) {
    const lista = e.faixas[id] || [];
    const quantidades = [];
    for (const f of lista) {
      const q = Number(f.quantidade_minima);
      if (!Number.isInteger(q) || q < 2) return `${titulo}: a quantidade mínima precisa ser um número inteiro a partir de 2.`;
      if (quantidades.includes(q)) return `${titulo}: há duas faixas com ${q} un.`;
      quantidades.push(q);
      const { unit, erro } = calcFaixa(f, preco);
      if (erro) return `${titulo}: ${erro}.`;
      if (unit >= preco) return `${titulo}: o preço da faixa de ${q} un precisa ser menor que o preço unitário (${brl(preco)}).`;
      if (f.ean_pack && !/^\d{8,14}$/.test(f.ean_pack)) return `${titulo}: o código de barras do pack precisa ter de 8 a 14 números.`;
    }
    const ord = lista.map((f) => ({ q: Number(f.quantidade_minima), u: calcFaixa(f, preco).unit })).sort((a, b) => a.q - b.q);
    for (let i = 1; i < ord.length; i++) if (ord[i].u >= ord[i - 1].u) return `${titulo}: o preço precisa diminuir conforme a quantidade aumenta (${ord[i].q} un não pode custar mais que ${ord[i - 1].q} un).`;
  }
  return '';
}

function FaixaCard({ f, i, lista, precoLoja, custo, onChange, onRemove }) {
  const { unit } = calcFaixa(f, precoLoja);
  const q = Number(f.quantidade_minima);
  const alertas = alertasDaFaixa(f, lista, precoLoja, custo);
  const desc = unit !== null && unit !== undefined && precoLoja > 0 ? (1 - unit / precoLoja) * 100 : null;
  const set = (patch) => onChange(i, { ...f, ...patch });
  return (
    <div className="pr-faixa">
      <div className="pr-faixa-campos">
        <Field label="Nome"><input value={f.rotulo} maxLength={40} placeholder={`Pack ${q || ''}`} onChange={(e) => set({ rotulo: e.target.value })} /></Field>
        <Field label="A partir de (un)"><input inputMode="numeric" value={f.quantidade_minima} onChange={(e) => set({ quantidade_minima: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Informar por">
          <select value={f.modo} onChange={(e) => onChange(i, converterModo(f, e.target.value, precoLoja))}>
            {MODOS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </select>
        </Field>
        <Field label={f.modo === 'percentual' ? 'Desconto (%)' : f.modo === 'kit' ? 'Preço do kit (R$)' : 'Preço por unidade (R$)'}>
          <input inputMode="decimal" value={f.valor} onChange={(e) => set({ valor: e.target.value })} />
        </Field>
        <Field label="Aplicação">
          <select value={f.automatica ? '1' : '0'} onChange={(e) => set({ automatica: e.target.value === '1' })}>
            <option value="1">Automático</option>
            <option value="0">Só se o operador escolher</option>
          </select>
        </Field>
      </div>
      <div className="pr-faixa-calc">
        <span>Por unidade <b>{unit !== null && unit !== undefined ? brl(unit) : '—'}</b></span>
        <span>Kit fechado <b>{unit !== null && unit !== undefined && q >= 2 ? brl(unit * q) : '—'}</b></span>
        <span>Desconto <b className={desc !== null && desc <= 0 ? 'pr-err' : 'pr-ok'}>{pctTxt(desc)}</b></span>
        <span>Margem <b className={unit !== null && unit !== undefined && custo > 0 && unit <= custo ? 'pr-err' : ''}>{pctTxt(unit !== null && unit !== undefined ? margemDe(unit, custo) : null)}</b></span>
      </div>
      <div className="pr-faixa-pe">
        <label className="pr-ean">EAN do pack (opcional)
          <input inputMode="numeric" value={f.ean_pack} placeholder="código do fardo" onChange={(e) => set({ ean_pack: e.target.value.replace(/\D/g, '').slice(0, 14) })} />
        </label>
        <div className="pr-alertas">
          {alertas.length === 0 ? <span className="pr-pill ok">ok</span> : alertas.map((a, k) => <span key={k} className={`pr-pill ${a.t}`}>{a.txt}</span>)}
        </div>
        <button type="button" className="pr-x" onClick={() => onRemove(i)} aria-label="Remover faixa" title="Remover faixa">×</button>
      </div>
    </div>
  );
}

export default function PrecosLoja({ estado, setEstado, locais, venda, custo, combo = false }) {
  const ativos = locais.filter((l) => l.ativo);
  const [escopo, setEscopo] = useState('geral');
  const { porLoja } = estado;
  const loja = ativos.find((l) => l.id === escopo) || null;
  const regraLoja = (id) => estado.lojas[id] || { preco: '', vende: true };
  const precoDaLoja = (id) => { const r = regraLoja(id); const p = String(r.preco || '').trim() === '' ? venda : num(r.preco); return p > 0 ? p : venda; };
  const faixasDe = (id) => (id === 'geral' ? estado.faixas.geral : estado.faixas[id]);
  const faixasEfetivas = (id) => faixasDe(id) || estado.faixas.geral || [];
  const setFaixas = (chave, lista) => setEstado({ ...estado, faixas: { ...estado.faixas, [chave]: lista } });
  const setLoja = (id, patch) => setEstado({ ...estado, lojas: { ...estado.lojas, [id]: { ...regraLoja(id), ...patch } } });

  function alternarPorLoja(v) {
    setEstado({ ...estado, porLoja: v });
    setEscopo(v && ativos[0] ? ativos[0].id : 'geral');
  }
  function copiarDe(origemId) {
    if (!loja || !origemId) return;
    const o = regraLoja(origemId);
    const lista = faixasDe(origemId);
    setEstado({
      ...estado,
      lojas: { ...estado.lojas, [loja.id]: { preco: o.preco, vende: o.vende } },
      faixas: { ...estado.faixas, [loja.id]: lista ? lista.map((f) => ({ ...f })) : undefined },
    });
  }

  const chaveAtual = porLoja ? escopo : 'geral';
  const lista = faixasDe(chaveAtual);
  const precoAtual = chaveAtual === 'geral' ? venda : precoDaLoja(chaveAtual);
  const trocar = (i, f) => setFaixas(chaveAtual, lista.map((x, k) => (k === i ? f : x)));
  const remover = (i) => setFaixas(chaveAtual, lista.filter((_, k) => k !== i));
  const adicionar = () => {
    const ult = lista.reduce((m, f) => Math.max(m, Number(f.quantidade_minima) || 0), 0);
    setFaixas(chaveAtual, [...lista, faixaNova(ult ? ult * 2 : 6)]);
  };

  return (
    <section className="pr-sec" id="secao-precos">
      <h4>Preços por loja e por quantidade</h4>
      <p className="muted pr-sub">Defina um preço diferente em cada loja e <b>descontos por quantidade</b> (pack, fardo, atacado). Quem não for configurado usa o preço padrão acima. O custo é um só, igual em todas as lojas; a margem é calculada por loja.</p>
      <label className="check">
        <input type="checkbox" checked={porLoja} onChange={(e) => alternarPorLoja(e.target.checked)} /> Preço diferente por loja
      </label>

      {porLoja && (
        <div className="pr-chips" role="tablist" aria-label="Loja">
          <button type="button" role="tab" aria-selected={escopo === 'geral'} className={`pr-chip ${escopo === 'geral' ? 'on' : ''}`} onClick={() => setEscopo('geral')}>Padrão (todas)</button>
          {ativos.map((l) => (
            <button type="button" role="tab" aria-selected={escopo === l.id} key={l.id} className={`pr-chip ${escopo === l.id ? 'on' : ''}`} onClick={() => setEscopo(l.id)}>
              <span className={`pr-dot ${regraLoja(l.id).vende === false ? 'off' : ''}`} />{l.nome}
            </button>
          ))}
        </div>
      )}

      {porLoja && loja && (
        <div className="pr-loja">
          <Field label={`Preço unitário em ${loja.nome} (R$)`} hint={`${margemDe(precoAtual, custo) === null ? '' : `Margem: ${pctTxt(margemDe(precoAtual, custo))} · lucro ${brl(precoAtual - custo)} por unidade`}${String(regraLoja(loja.id).preco || '').trim() === '' ? ' · usa o preço padrão' : ''}`}>
            <input inputMode="decimal" value={regraLoja(loja.id).preco} placeholder={`padrão: ${virg(Number(venda || 0).toFixed(2))}`} onChange={(e) => setLoja(loja.id, { preco: e.target.value })} />
          </Field>
          <label className="check pr-vende">
            <input type="checkbox" checked={regraLoja(loja.id).vende !== false} onChange={(e) => setLoja(loja.id, { vende: e.target.checked })} /> Vende nesta loja
          </label>
          {ativos.length > 1 && (
            <Field label="Copiar regras de…">
              <select value="" onChange={(e) => copiarDe(e.target.value)}>
                <option value="">escolha</option>
                {ativos.filter((l) => l.id !== loja.id).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
              </select>
            </Field>
          )}
          {regraLoja(loja.id).vende === false && <div className="pr-aviso">Este produto <b>não aparece</b> no PDV, nos pedidos nem no app do garçom desta loja, e a venda é recusada.</div>}
        </div>
      )}

      {combo ? (
        <p className="muted pr-sub">Combos não têm desconto por quantidade (aceitam preço por loja).</p>
      ) : (
        <div className="pr-faixas">
          <div className="pr-faixas-topo">
            <b>Descontos por quantidade{porLoja ? (chaveAtual === 'geral' ? ' (lojas sem faixas próprias)' : ` em ${loja ? loja.nome : ''}`) : ''}</b>
            <span className="muted">pack / fardo / atacado</span>
            {(chaveAtual === 'geral' || lista) && <button type="button" className="btn-link" onClick={adicionar}>+ faixa</button>}
          </div>
          {chaveAtual !== 'geral' && !lista ? (
            <div className="pr-vazio">
              Esta loja usa as <b>faixas padrão</b> ({(estado.faixas.geral || []).length === 0 ? 'nenhuma' : (estado.faixas.geral || []).length}).
              <button type="button" className="btn-link" onClick={() => setFaixas(chaveAtual, (estado.faixas.geral || []).map((f) => ({ ...f })))}>Criar faixas próprias para esta loja</button>
            </div>
          ) : lista.length === 0 ? (
            <div className="pr-vazio">Sem desconto por quantidade. Use <b>+ faixa</b> para vender pack, fardo ou atacado.</div>
          ) : (
            lista.map((f, i) => <FaixaCard key={i} f={f} i={i} lista={lista} precoLoja={precoAtual} custo={custo} onChange={trocar} onRemove={remover} />)
          )}
          {chaveAtual !== 'geral' && lista && (
            <button type="button" className="btn-link" onClick={() => setFaixas(chaveAtual, undefined)}>Voltar a usar as faixas padrão</button>
          )}
        </div>
      )}

      <div className="pr-resumo">
        <div className="pr-resumo-cab"><span>Loja</span><span>Unidade</span><span>Margem</span><span>Descontos por quantidade</span></div>
        {(porLoja ? ativos : [{ id: 'geral', nome: 'Todas as lojas' }]).map((l) => {
          const p = l.id === 'geral' ? venda : precoDaLoja(l.id);
          const vende = l.id === 'geral' || regraLoja(l.id).vende !== false;
          const fx = combo ? [] : faixasEfetivas(l.id);
          const m = margemDe(p, custo);
          return (
            <div className="pr-resumo-linha" key={l.id}>
              <span><b>{l.nome}</b> {!vende && <em className="pr-pill err">não vende</em>}</span>
              <span>{brl(p)}{l.id !== 'geral' && String(regraLoja(l.id).preco || '').trim() === '' && <small> (padrão)</small>}</span>
              <span className={m !== null && m < 10 ? 'pr-warn' : ''}>{pctTxt(m)}</span>
              <span>{fx.length === 0 ? <small className="muted">sem desconto por quantidade</small> : fx.map((f, k) => {
                const { unit } = calcFaixa(f, p);
                return <em key={k} className="pr-tag">{f.rotulo || `${f.quantidade_minima} un`}: {f.quantidade_minima} un × {unit === null || unit === undefined ? '—' : brl(unit)}{f.automatica === false ? ' (manual)' : ''}</em>;
              })}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

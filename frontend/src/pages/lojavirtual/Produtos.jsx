import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field, Modal, Paginacao, Vazio } from '../../components/ui.jsx';
import { brl, parseNumero, qtd } from '../../utils/format';
import { enviarImagem } from '../../utils/imagem';

const FILTROS = [['todos', 'Todos'], ['publicados', 'No site'], ['nao_publicados', 'Fora do site'], ['promocao', 'Em promoção'], ['sem_foto', 'No site sem foto']];
const LIMITE = 50;
const diaBR = (d) => (d ? d.split('-').reverse().join('/') : '');

// Produtos do cadastro que vao para o site: o preco e o estoque continuam os do sistema; aqui entram foto,
// descricao, nome no site, promocao e destaque.
export default function Produtos({ config }) {
  const toast = useToast();
  const [situacao, setSituacao] = useState('todos');
  const [busca, setBusca] = useState('');
  const [offset, setOffset] = useState(0);
  const [lista, setLista] = useState(null);
  const [marcados, setMarcados] = useState([]);
  const [editando, setEditando] = useState(null);
  const carregar = useCallback(async (o = 0) => {
    try {
      const q = new URLSearchParams({ situacao, limit: String(LIMITE), offset: String(o) });
      if (busca.trim()) q.set('busca', busca.trim());
      setLista(await api.get(`/loja-virtual/produtos?${q}`));
      setOffset(o);
    } catch (err) { toast.erro(err); }
  }, [situacao, busca, toast]);
  useEffect(() => { const t = setTimeout(() => carregar(0), 250); return () => clearTimeout(t); }, [carregar]);
  useEffect(() => { setMarcados([]); }, [situacao, busca]);

  async function publicar(ids, sim) {
    try {
      await api.post('/loja-virtual/produtos/publicar', { ids, publicado: sim });
      toast.sucesso(sim ? `${ids.length} produto(s) no site` : `${ids.length} produto(s) fora do site`);
      setMarcados([]);
      await carregar(offset);
    } catch (err) { toast.erro(err); }
  }
  const itens = lista ? lista.itens : [];
  const todosMarcados = itens.length > 0 && itens.every((p) => marcados.includes(p.id));
  return (
    <div className="form-stack">
      {!config.location_id && <div className="ped-nota">Escolha em <b>Visão geral</b> o estabelecimento da loja: é o estoque dele que define o que aparece disponível no site.</div>}
      <div className="card">
        <div className="es-chips" role="group" aria-label="Filtro">
          {FILTROS.map(([id, nome]) => <button key={id} type="button" className={`es-chip ${situacao === id ? 'on' : ''}`} aria-pressed={situacao === id} onClick={() => setSituacao(id)}>{nome}</button>)}
        </div>
        <input type="search" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nome, código ou código de barras" aria-label="Buscar produto" style={{ width: '100%' }} />
        {marcados.length > 0 && (
          <div className="lv-lote">
            <b>{marcados.length} selecionado(s)</b>
            <button type="button" className="btn-primario" onClick={() => publicar(marcados, true)}>Colocar no site</button>
            <button type="button" onClick={() => publicar(marcados, false)}>Tirar do site</button>
            <button type="button" className="btn-link" onClick={() => setMarcados([])}>Limpar</button>
          </div>
        )}
      </div>
      <div className="card">
        {!lista ? <p className="muted">Carregando…</p> : itens.length === 0 ? <Vazio>Nenhum produto neste filtro.</Vazio> : (
          <>
            <div className="tabela-wrap">
              <table className="tabela-cartoes lv-produtos">
                <thead>
                  <tr>
                    <th className="lv-col-marca"><input type="checkbox" aria-label="Selecionar todos" checked={todosMarcados} onChange={(e) => setMarcados(e.target.checked ? itens.map((p) => p.id) : [])} /></th>
                    <th>Produto</th><th className="num">Preço no site</th><th className="num">Disponível</th><th>No site</th><th />
                  </tr>
                </thead>
                <tbody>
                  {itens.map((p) => (
                    <tr key={p.id}>
                      <td className="lv-col-marca"><input type="checkbox" aria-label={`Selecionar ${p.nome}`} checked={marcados.includes(p.id)} onChange={(e) => setMarcados(e.target.checked ? [...marcados, p.id] : marcados.filter((x) => x !== p.id))} /></td>
                      <td>
                        <div className="lv-prod">
                          <span className="lv-thumb">{p.imagens[0] ? <img src={p.imagens[0].url} alt="" loading="lazy" /> : <span aria-hidden="true">📷</span>}</span>
                          <span><b>{p.nome_site || p.nome}</b>{p.destaque && <span className="ped-pill ok lv-mini">destaque</span>}{p.maior_idade && <span className="ped-pill err lv-mini">+18</span>}{p.so_retirada && <span className="ped-pill warn lv-mini">só retirada</span>}<div className="celula-sub">{p.codigo_interno}{p.categoria_nome ? ` · ${p.categoria_nome}` : ''}{p.nome_site ? ` · cadastro: ${p.nome}` : ''}</div></span>
                        </div>
                      </td>
                      <td className="num">
                        {p.preco_site.preco_original ? <><s className="muted">{brl(p.preco_site.preco_original)}</s> <b style={{ color: 'var(--ok)' }}>{brl(p.preco_site.preco)}</b></> : <b>{brl(p.preco_site.preco)}</b>}
                        {p.preco_promocional && !p.preco_site.preco_original && <div className="celula-sub">promoção fora do período</div>}
                      </td>
                      <td className="num">{p.disponivel === null ? '—' : p.disponivel > 0 ? qtd(p.disponivel, p.unidade) : <span style={{ color: 'var(--err)' }}>esgotado</span>}</td>
                      <td>
                        <label className="lv-switch">
                          <input type="checkbox" checked={p.publicado} onChange={(e) => publicar([p.id], e.target.checked)} aria-label={`${p.nome} no site`} />
                          <span>{p.publicado ? 'No site' : 'Fora'}</span>
                        </label>
                      </td>
                      <td className="num"><button type="button" className="btn-link" onClick={() => setEditando(p)}>Editar</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Paginacao total={lista.total} limit={LIMITE} offset={offset} onChange={carregar} />
          </>
        )}
      </div>
      <GradesSite busca={busca} frete={config.tipo !== 'cardapio'} />
      {editando && <EditarProduto p={editando} frete={config.tipo !== 'cardapio'} onClose={() => setEditando(null)} onSalvo={async () => { setEditando(null); await carregar(offset); }} />}
    </div>
  );
}

const medida = (v) => (v === null || v === undefined ? '' : String(Number(v)).replace('.', ','));
function EditarProduto({ p, frete, onClose, onSalvo }) {
  const toast = useToast();
  const [f, setF] = useState({
    publicado: p.publicado,
    nome_site: p.nome_site || '', descricao: p.descricao || '', destaque: p.destaque,
    preco_promocional: p.preco_promocional ? String(p.preco_promocional).replace('.', ',') : '', promo_inicio: p.promo_inicio || '', promo_fim: p.promo_fim || '',
    maior_idade: !!p.maior_idade, so_retirada: !!p.so_retirada, peso_kg: medida(p.peso_kg), altura_cm: medida(p.altura_cm), largura_cm: medida(p.largura_cm), comprimento_cm: medida(p.comprimento_cm),
  });
  const [fotos, setFotos] = useState(p.imagens);
  const [enviando, setEnviando] = useState(0);
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function adicionarFotos(e) {
    const arqs = [...(e.target.files || [])].slice(0, 8 - fotos.length);
    e.target.value = '';
    for (const a of arqs) {
      setEnviando((n) => n + 1);
      try {
        const r = await enviarImagem(a);
        setFotos((atual) => [...atual, r]);
      } catch (err) { toast.erro(err); } finally { setEnviando((n) => n - 1); }
    }
  }
  const mover = (i, d) => setFotos((l) => { const n = [...l]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  async function salvar(e) {
    e.preventDefault();
    const promo = f.preco_promocional.trim() ? parseNumero(f.preco_promocional) : null;
    try {
      await api.put(`/loja-virtual/produtos/${p.id}`, {
        publicado: f.publicado, nome_site: f.nome_site, descricao: f.descricao, destaque: f.destaque, imagens: fotos.map((x) => x.id),
        preco_promocional: promo, promo_inicio: promo ? f.promo_inicio || null : null, promo_fim: promo ? f.promo_fim || null : null,
        maior_idade: f.maior_idade, so_retirada: f.so_retirada,
        ...(frete ? Object.fromEntries(['peso_kg', 'altura_cm', 'largura_cm', 'comprimento_cm'].map((k) => [k, f[k].trim() ? parseNumero(f[k]) : null])) : {}),
      });
      toast.sucesso('Produto salvo');
      await onSalvo();
    } catch (err) { toast.erro(err); }
  }
  const promo = parseNumero(f.preco_promocional);
  return (
    <Modal titulo={p.nome} subtitulo={`${p.codigo_interno} · preço de venda ${brl(p.preco_venda)} (o preço e o estoque vêm do cadastro)`} onClose={onClose} largura="larga">
      <form className="form-stack" onSubmit={salvar}>
        <label className="check"><input type="checkbox" checked={f.publicado} onChange={mudar('publicado')} /> Mostrar este produto no site</label>
        <div>
          <span className="ped-rotulo">Fotos ({fotos.length}/8) — a primeira é a principal</span>
          <div className="lv-fotos">
            {fotos.map((x, i) => (
              <div key={x.id} className="lv-foto">
                <img src={x.url} alt={`Foto ${i + 1}`} />
                <div className="lv-foto-acoes">
                  <button type="button" disabled={i === 0} onClick={() => mover(i, -1)} aria-label="Mover para a esquerda">‹</button>
                  <button type="button" className="perigo" onClick={() => setFotos(fotos.filter((_, j) => j !== i))} aria-label="Remover foto">×</button>
                  <button type="button" disabled={i === fotos.length - 1} onClick={() => mover(i, 1)} aria-label="Mover para a direita">›</button>
                </div>
              </div>
            ))}
            {fotos.length < 8 && (
              <label className="lv-foto lv-foto-nova">
                <span>{enviando ? 'Enviando…' : '+ Foto'}</span>
                <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={adicionarFotos} />
              </label>
            )}
          </div>
        </div>
        <Field label="Nome no site" hint="Deixe vazio para usar o nome do cadastro."><input value={f.nome_site} onChange={mudar('nome_site')} placeholder={p.nome} maxLength={120} /></Field>
        <Field label="Descrição"><textarea rows={3} value={f.descricao} onChange={mudar('descricao')} maxLength={2000} placeholder="Ingredientes, tamanho, sabor…" /></Field>
        <div className="form-grid lv-grid-3">
          <Field label="Preço promocional (R$)"><input inputMode="decimal" value={f.preco_promocional} onChange={mudar('preco_promocional')} placeholder="sem promoção" /></Field>
          <Field label="Promoção de"><input type="date" value={f.promo_inicio} onChange={mudar('promo_inicio')} disabled={!f.preco_promocional.trim()} /></Field>
          <Field label="até"><input type="date" value={f.promo_fim} onChange={mudar('promo_fim')} disabled={!f.preco_promocional.trim()} /></Field>
        </div>
        {promo > 0 && <p className="form-hint" style={{ margin: 0 }}>{promo < Number(p.preco_venda) ? `De ${brl(p.preco_venda)} por ${brl(promo)} (${Math.round((1 - promo / Number(p.preco_venda)) * 100)}% off)${f.promo_inicio || f.promo_fim ? `, ${f.promo_inicio ? `de ${diaBR(f.promo_inicio)} ` : ''}${f.promo_fim ? `até ${diaBR(f.promo_fim)}` : ''}` : ', sem data para acabar'}.` : 'O preço promocional precisa ser menor que o preço de venda.'}</p>}
        <label className="check"><input type="checkbox" checked={f.destaque} onChange={mudar('destaque')} /> Destaque (aparece primeiro e na vitrine de destaques)</label>
        <label className="check"><input type="checkbox" checked={f.maior_idade} onChange={mudar('maior_idade')} /> Venda para maiores de 18 anos (selo +18; o cliente declara a idade ao fechar o pedido)</label>
        <label className="check"><input type="checkbox" checked={f.so_retirada} onChange={mudar('so_retirada')} /> Somente retirada na loja (não é entregue nem enviado; ex.: produtos de tabaco, cuja venda por via postal a lei proíbe)</label>
        {frete && (
          <div>
            <span className="ped-rotulo">Peso e medidas da embalagem (frete por transportadora)</span>
            <div className="form-grid lv-grid-4">
              <Field label="Peso (kg)"><input inputMode="decimal" value={f.peso_kg} onChange={mudar('peso_kg')} placeholder="padrão" /></Field>
              <Field label="Altura (cm)"><input inputMode="decimal" value={f.altura_cm} onChange={mudar('altura_cm')} placeholder="padrão" /></Field>
              <Field label="Largura (cm)"><input inputMode="decimal" value={f.largura_cm} onChange={mudar('largura_cm')} placeholder="padrão" /></Field>
              <Field label="Comprimento (cm)"><input inputMode="decimal" value={f.comprimento_cm} onChange={mudar('comprimento_cm')} placeholder="padrão" /></Field>
            </div>
            <p className="form-hint" style={{ margin: 0 }}>Vazio = a embalagem padrão da loja (Entrega). Medidas do produto já embalado.</p>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-primario" disabled={enviando > 0}>Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

// Grades de variacoes (cor, tamanho...): publicadas inteiras no site, com seletores. Fotos gerais e por valor (ex.: por cor).
function GradesSite({ busca, frete }) {
  const toast = useToast();
  const [lista, setLista] = useState(null);
  const [editando, setEditando] = useState(null);
  const carregar = useCallback(() => api.get(`/loja-virtual/grades${busca.trim() ? `?busca=${encodeURIComponent(busca.trim())}` : ''}`).then(setLista).catch((err) => toast.erro(err)), [busca, toast]);
  useEffect(() => { const t = setTimeout(carregar, 250); return () => clearTimeout(t); }, [carregar]);
  if (!lista || lista.length === 0) return null;
  return (
    <div className="card">
      <div className="ped-head" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}>Grades de variações</h3></div>
      <p className="form-hint" style={{ marginTop: 0 }}>Cada grade aparece no site como um produto só, com a escolha de {[...new Set(lista.flatMap((g) => g.atributos.map((a) => a.nome.toLowerCase())))].slice(0, 3).join(', ')}. Preço e estoque vêm de cada variação.</p>
      <div className="tabela-wrap">
        <table className="tabela-cartoes">
          <thead><tr><th>Grade</th><th>Opções</th><th className="num">Preço</th><th>No site</th><th /></tr></thead>
          <tbody>
            {lista.map((g) => (
              <tr key={g.id}>
                <td>
                  <div className="lv-prod">
                    <span className="lv-thumb">{g.imagens[0] ? <img src={g.imagens[0].url} alt="" loading="lazy" /> : <span aria-hidden="true">📷</span>}</span>
                    <span><b>{g.nome_site || g.nome}</b>{g.maior_idade && <span className="ped-pill err lv-mini">+18</span>}{g.so_retirada && <span className="ped-pill warn lv-mini">só retirada</span>}<div className="celula-sub">{g.variacoes} variação(ões){g.categoria_nome ? ` · ${g.categoria_nome}` : ''}</div></span>
                  </div>
                </td>
                <td>{g.atributos.map((a) => <div key={a.nome} className="celula-sub">{a.nome}: {a.valores.join(', ')}</div>)}</td>
                <td className="num">{g.preco_min === g.preco_max ? brl(g.preco_min) : `${brl(g.preco_min)} a ${brl(g.preco_max)}`}{g.promo_pct ? <div className="celula-sub">-{g.promo_pct}% promoção</div> : null}</td>
                <td>{g.configurado && g.publicado ? <span className="ped-pill ok">no site</span> : <span className="ped-pill">fora do site</span>}</td>
                <td className="num"><button type="button" className="btn-link" onClick={() => setEditando(g)}>{g.configurado ? 'Editar' : 'Colocar no site'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editando && <EditarGradeSite g={editando} frete={frete} onClose={() => setEditando(null)} onSalvo={async () => { setEditando(null); await carregar(); }} />}
    </div>
  );
}

function EditarGradeSite({ g, frete, onClose, onSalvo }) {
  const toast = useToast();
  const [f, setF] = useState({
    publicado: g.configurado ? g.publicado : true, nome_site: g.nome_site || '', descricao: g.descricao, destaque: g.destaque,
    promo_pct: g.promo_pct ? String(g.promo_pct).replace('.', ',') : '', promo_inicio: g.promo_inicio || '', promo_fim: g.promo_fim || '',
    maior_idade: g.maior_idade, so_retirada: g.so_retirada,
    peso_kg: medida(g.peso_kg), altura_cm: medida(g.altura_cm), largura_cm: medida(g.largura_cm), comprimento_cm: medida(g.comprimento_cm),
    atributo_foto: g.atributo_foto || (g.atributos.find((a) => /cor/i.test(a.nome)) || {}).nome || '',
  });
  const [fotos, setFotos] = useState(g.imagens);
  const [porValor, setPorValor] = useState(g.fotos_por_valor || {});
  const [enviando, setEnviando] = useState(0);
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function enviar(e, aoEnviar) {
    const arqs = [...(e.target.files || [])].slice(0, 8);
    e.target.value = '';
    for (const a of arqs) {
      setEnviando((n) => n + 1);
      try { aoEnviar(await enviarImagem(a)); } catch (err) { toast.erro(err); } finally { setEnviando((n) => n - 1); }
    }
  }
  const atributoFoto = g.atributos.find((a) => a.nome === f.atributo_foto);
  async function salvar(e) {
    e.preventDefault();
    try {
      await api.put(`/loja-virtual/grades/${g.id}`, {
        publicado: f.publicado, nome_site: f.nome_site, descricao: f.descricao, destaque: f.destaque, imagens: fotos.map((x) => x.id),
        atributo_foto: f.atributo_foto || null,
        fotos_por_valor: f.atributo_foto ? Object.fromEntries(Object.entries(porValor).filter(([k]) => atributoFoto && atributoFoto.valores.includes(k)).map(([k, l]) => [k, l.map((x) => x.id)])) : {},
        promo_pct: f.promo_pct.trim() ? parseNumero(f.promo_pct) : null, promo_inicio: f.promo_inicio || null, promo_fim: f.promo_fim || null,
        maior_idade: f.maior_idade, so_retirada: f.so_retirada,
        ...(frete ? Object.fromEntries(['peso_kg', 'altura_cm', 'largura_cm', 'comprimento_cm'].map((k) => [k, f[k].trim() ? parseNumero(f[k]) : null])) : {}),
      });
      toast.sucesso(f.publicado ? 'Grade no site' : 'Grade salva (fora do site)');
      await onSalvo();
    } catch (err) { toast.erro(err); }
  }
  const Fotos = ({ lista, setLista, rotulo }) => (
    <div>
      <span className="ped-rotulo">{rotulo} ({lista.length}/8)</span>
      <div className="lv-fotos">
        {lista.map((x, i) => (
          <div key={x.id} className="lv-foto">
            <img src={x.url} alt={`Foto ${i + 1}`} />
            <div className="lv-foto-acoes"><button type="button" className="perigo" onClick={() => setLista(lista.filter((_, j) => j !== i))} aria-label="Remover foto">×</button></div>
          </div>
        ))}
        {lista.length < 8 && (
          <label className="lv-foto lv-foto-nova">
            <span>{enviando ? 'Enviando…' : '+ Foto'}</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => enviar(e, (r) => setLista((atual) => [...atual, r]))} />
          </label>
        )}
      </div>
    </div>
  );
  return (
    <Modal titulo={g.nome} subtitulo={`Grade com ${g.variacoes} variação(ões) · preço e estoque de cada variação vêm do cadastro`} onClose={onClose} largura="larga">
      <form className="form-stack" onSubmit={salvar}>
        <label className="check"><input type="checkbox" checked={f.publicado} onChange={mudar('publicado')} /> Mostrar esta grade no site</label>
        <Fotos lista={fotos} setLista={setFotos} rotulo="Fotos gerais (a primeira aparece no card)" />
        <Field label="Trocar a foto conforme">
          <select value={f.atributo_foto} onChange={mudar('atributo_foto')}><option value="">Não trocar</option>{g.atributos.map((a) => <option key={a.nome} value={a.nome}>{a.nome}</option>)}</select>
        </Field>
        {atributoFoto && atributoFoto.valores.map((valor) => (
          <Fotos key={valor} lista={porValor[valor] || []} setLista={(fn) => setPorValor((pv) => ({ ...pv, [valor]: typeof fn === 'function' ? fn(pv[valor] || []) : fn }))} rotulo={`Fotos: ${valor}`} />
        ))}
        <Field label="Nome no site" hint="Vazio = o nome da grade"><input value={f.nome_site} onChange={mudar('nome_site')} placeholder={g.nome} maxLength={120} /></Field>
        <Field label="Descrição"><textarea rows={3} value={f.descricao} onChange={mudar('descricao')} maxLength={2000} /></Field>
        <div className="form-grid lv-grid-3">
          <Field label="Promoção (% em todas)"><input inputMode="decimal" value={f.promo_pct} onChange={mudar('promo_pct')} placeholder="sem promoção" /></Field>
          <Field label="de"><input type="date" value={f.promo_inicio} onChange={mudar('promo_inicio')} disabled={!f.promo_pct.trim()} /></Field>
          <Field label="até"><input type="date" value={f.promo_fim} onChange={mudar('promo_fim')} disabled={!f.promo_pct.trim()} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.destaque} onChange={mudar('destaque')} /> Destaque</label>
        <label className="check"><input type="checkbox" checked={f.maior_idade} onChange={mudar('maior_idade')} /> Venda para maiores de 18 anos</label>
        <label className="check"><input type="checkbox" checked={f.so_retirada} onChange={mudar('so_retirada')} /> Somente retirada na loja</label>
        {frete && (
          <div className="form-grid lv-grid-4">
            <Field label="Peso (kg)"><input inputMode="decimal" value={f.peso_kg} onChange={mudar('peso_kg')} placeholder="padrão" /></Field>
            <Field label="Altura (cm)"><input inputMode="decimal" value={f.altura_cm} onChange={mudar('altura_cm')} placeholder="padrão" /></Field>
            <Field label="Largura (cm)"><input inputMode="decimal" value={f.largura_cm} onChange={mudar('largura_cm')} placeholder="padrão" /></Field>
            <Field label="Comprimento (cm)"><input inputMode="decimal" value={f.comprimento_cm} onChange={mudar('comprimento_cm')} placeholder="padrão" /></Field>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-primario" disabled={enviando > 0}>Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

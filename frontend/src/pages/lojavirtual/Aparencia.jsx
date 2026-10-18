import { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field } from '../../components/ui.jsx';
import { enviarImagem } from '../../utils/imagem';

const MODELOS = [
  ['classico', 'Clássico', 'Grade de produtos com foto quadrada. Bom para quase tudo.'],
  ['vitrine', 'Vitrine', 'Fotos grandes, com descrição. Bom para poucos produtos bonitos.'],
  ['compacto', 'Cardápio', 'Lista com foto pequena. Ideal para lanchonete e delivery.'],
];
const FONTES = [['moderna', 'Moderna'], ['classica', 'Clássica (serifada)'], ['arredondada', 'Arredondada']];
const NOME_BLOCO = { banners: 'Banners', categorias: 'Categorias', destaques: 'Destaques', promocoes: 'Promoções', produtos: 'Todos os produtos' };
const PALETAS = [
  ['Vermelho', { cor_primaria: '#b5121b', cor_destaque: '#1f7a4d', cor_fundo: '#ffffff', cor_texto: '#1d1d1f' }],
  ['Laranja', { cor_primaria: '#e8590c', cor_destaque: '#2b8a3e', cor_fundo: '#fffaf5', cor_texto: '#2b2118' }],
  ['Verde', { cor_primaria: '#2b8a3e', cor_destaque: '#e8590c', cor_fundo: '#ffffff', cor_texto: '#1b2a1f' }],
  ['Azul', { cor_primaria: '#1c4ed8', cor_destaque: '#0f9d58', cor_fundo: '#ffffff', cor_texto: '#111827' }],
  ['Roxo', { cor_primaria: '#6d28d9', cor_destaque: '#db2777', cor_fundo: '#ffffff', cor_texto: '#1f1a2e' }],
  ['Escuro', { cor_primaria: '#f2b705', cor_destaque: '#22c55e', cor_fundo: '#141414', cor_texto: '#f4f4f5' }],
];
const CORES = [['cor_primaria', 'Cor principal (botões e destaques)'], ['cor_destaque', 'Cor de oferta (selo de desconto)'], ['cor_fundo', 'Fundo'], ['cor_texto', 'Texto']];

// Layout do site da loja. O site e o mesmo para todas as empresas; aqui a empresa escolhe o visual dela.
export default function Aparencia({ config, onMudou }) {
  const toast = useToast();
  const [t, setT] = useState(config.tema);
  const [banners, setBanners] = useState(config.banners.map((b) => ({ imagem_id: b.imagem_id, url: b.url, titulo: b.titulo || '', link: b.link || '' })));
  const [enviando, setEnviando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const mover = (lista, i, d) => { const n = [...lista]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; };

  async function addBanner(e) {
    const arq = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!arq) return;
    setEnviando(true);
    try { const r = await enviarImagem(arq, 1600); setBanners((l) => [...l, { imagem_id: r.id, url: r.url, titulo: '', link: '' }]); } catch (err) { toast.erro(err); } finally { setEnviando(false); }
  }
  async function salvar() {
    setSalvando(true);
    try {
      await api.put('/loja-virtual', { tema: t, banners: banners.map(({ imagem_id, titulo, link }) => ({ imagem_id, titulo, link })) });
      toast.sucesso('Aparência salva');
      await onMudou();
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  return (
    <div className="form-stack">
      <div className="card form-stack">
        <div className="ped-head" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: 0 }}>Modelo de layout</h3>
          {config.url_previa && <a className="btn-link" href={config.url_previa} target="_blank" rel="noreferrer">Ver a loja ↗</a>}
        </div>
        <div className="lv-modelos" role="radiogroup" aria-label="Modelo de layout">
          {MODELOS.map(([k, nome, desc]) => (
            <button key={k} type="button" role="radio" aria-checked={t.modelo === k} className={`lv-modelo ${t.modelo === k ? 'on' : ''}`} onClick={() => setT({ ...t, modelo: k })}>
              <span className={`lv-modelo-desenho ${k}`} aria-hidden="true"><i /><i /><i /><i /></span>
              <b>{nome}</b><small>{desc}</small>
            </button>
          ))}
        </div>
        {t.exclusivo && <p className="form-hint" style={{ margin: 0 }}>Esta loja usa o tema exclusivo <b>{t.exclusivo}</b>.</p>}
      </div>

      <div className="card form-stack">
        <h3 style={{ margin: 0 }}>Cores e fonte</h3>
        <div className="es-chips" role="group" aria-label="Paletas prontas">
          {PALETAS.map(([nome, cores]) => (
            <button key={nome} type="button" className="es-chip lv-paleta" onClick={() => setT({ ...t, ...cores })}>
              <span style={{ background: cores.cor_primaria }} /><span style={{ background: cores.cor_fundo }} />{nome}
            </button>
          ))}
        </div>
        <div className="lv-cores">
          {CORES.map(([k, nome]) => (
            <label key={k} className="lv-cor">
              <input type="color" value={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value })} aria-label={nome} />
              <span>{nome}<small>{t[k]}</small></span>
            </label>
          ))}
        </div>
        <div className="form-grid">
          <Field label="Fonte"><select value={t.fonte} onChange={(e) => setT({ ...t, fonte: e.target.value })}>{FONTES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></Field>
          <Field label="Cantos"><select value={t.cantos} onChange={(e) => setT({ ...t, cantos: e.target.value })}><option value="arredondados">Arredondados</option><option value="retos">Retos</option></select></Field>
        </div>
        <div className="lv-amostra" style={{ background: t.cor_fundo, color: t.cor_texto, borderRadius: t.cantos === 'retos' ? 2 : 12 }}>
          <b>Amostra</b>
          <span className="lv-amostra-preco">De <s>R$ 12,00</s> por <b style={{ color: t.cor_primaria }}>R$ 9,90</b> <i style={{ background: t.cor_destaque }}>-18%</i></span>
          <span className="lv-amostra-botao" style={{ background: t.cor_primaria, borderRadius: t.cantos === 'retos' ? 2 : 10 }}>Adicionar</span>
        </div>
      </div>

      <div className="card form-stack">
        <h3 style={{ margin: 0 }}>Banners da página inicial</h3>
        <p className="form-hint" style={{ margin: 0 }}>Imagens largas (ex.: 1600 × 600). O primeiro aparece primeiro.</p>
        {banners.map((b, i) => (
          <div key={b.imagem_id} className="lv-banner">
            <img src={b.url} alt="" />
            <div className="form-stack" style={{ flex: 1, minWidth: 0 }}>
              <input value={b.titulo} onChange={(e) => setBanners(banners.map((x, j) => (j === i ? { ...x, titulo: e.target.value } : x)))} placeholder="Texto sobre a imagem (opcional)" maxLength={80} aria-label="Texto do banner" />
              <input value={b.link} onChange={(e) => setBanners(banners.map((x, j) => (j === i ? { ...x, link: e.target.value } : x)))} placeholder="Link ao clicar (opcional)" aria-label="Link do banner" />
            </div>
            <div className="lv-ordem">
              <button type="button" disabled={i === 0} onClick={() => setBanners(mover(banners, i, -1))} aria-label="Subir">↑</button>
              <button type="button" disabled={i === banners.length - 1} onClick={() => setBanners(mover(banners, i, 1))} aria-label="Descer">↓</button>
              <button type="button" className="perigo" onClick={() => setBanners(banners.filter((_, j) => j !== i))} aria-label="Remover banner">×</button>
            </div>
          </div>
        ))}
        {banners.length < 8 && <label className="btn-link lv-arquivo">{enviando ? 'Enviando…' : '+ Banner'}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={addBanner} disabled={enviando} /></label>}
      </div>

      <div className="card form-stack">
        <h3 style={{ margin: 0 }}>Página inicial</h3>
        <p className="form-hint" style={{ margin: 0 }}>Escolha o que aparece e em que ordem. O título pode ser trocado (ex.: “Mais pedidos”).</p>
        {t.blocos.map((b, i) => (
          <div key={b.tipo} className="lv-bloco">
            <label className="check"><input type="checkbox" checked={b.ativo} onChange={(e) => setT({ ...t, blocos: t.blocos.map((x, j) => (j === i ? { ...x, ativo: e.target.checked } : x)) })} /> {NOME_BLOCO[b.tipo]}</label>
            {b.tipo !== 'banners' && <input value={b.titulo} onChange={(e) => setT({ ...t, blocos: t.blocos.map((x, j) => (j === i ? { ...x, titulo: e.target.value } : x)) })} placeholder={NOME_BLOCO[b.tipo]} maxLength={60} aria-label={`Título de ${NOME_BLOCO[b.tipo]}`} disabled={!b.ativo} />}
            <div className="lv-ordem">
              <button type="button" disabled={i === 0} onClick={() => setT({ ...t, blocos: mover(t.blocos, i, -1) })} aria-label={`Subir ${NOME_BLOCO[b.tipo]}`}>↑</button>
              <button type="button" disabled={i === t.blocos.length - 1} onClick={() => setT({ ...t, blocos: mover(t.blocos, i, 1) })} aria-label={`Descer ${NOME_BLOCO[b.tipo]}`}>↓</button>
            </div>
          </div>
        ))}
      </div>
      <div className="lv-salvar-fixo"><button type="button" className="btn-primario" onClick={salvar} disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar aparência'}</button></div>
    </div>
  );
}

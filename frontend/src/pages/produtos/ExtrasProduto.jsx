import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Field } from '../../components/ui.jsx';
import ProdutoPicker from '../../components/ProdutoPicker.jsx';
import { brl, parseNumero } from '../../utils/format';

// Custo do combo = soma (custo do componente x quantidade).
export function custoDoCombo(itens, produtos) {
  return itens.reduce((s, i) => s + Number((produtos.find((p) => p.id === i.product_id) || {}).preco_custo || 0) * Number(i.quantidade || 0), 0);
}

// Componentes do combo: produtos (revenda ou lanche) com quantidade. Combo dentro de combo nao existe.
export function ComboEditor({ itens, setItens, produtos, proprioId }) {
  const elegiveis = produtos.filter((p) => p.ativo && !p.e_combo && p.id !== proprioId && !itens.some((i) => i.product_id === p.id));
  const nome = (id) => (produtos.find((p) => p.id === id) || {}).nome || 'produto';
  return (
    <div className="form-stack extras-bloco">
      <div className="es-titulo" style={{ marginBottom: 0 }}>Combo (feito de outros produtos)</div>
      <p className="form-hint" style={{ marginTop: 4 }}>O combo <b>não tem estoque próprio</b>: cada venda baixa os produtos abaixo (o estoque da revenda e os insumos dos lanches). Para deixar o cliente escolher a bebida, crie um grupo de complementos (ex.: "Escolha a bebida", mínimo 1, máximo 1) e marque abaixo.</p>
      {itens.length > 0 && (
        <div className="tabela-wrap"><table className="compacta">
          <thead><tr><th>Produto</th><th className="num">Qtd.</th><th className="num">Custo</th><th /></tr></thead>
          <tbody>
            {itens.map((i) => {
              const p = produtos.find((x) => x.id === i.product_id) || {};
              return (
                <tr key={i.product_id}>
                  <td>{nome(i.product_id)}{p.tem_ficha_tecnica && <span className="celula-sub"> lanche (insumos)</span>}</td>
                  <td className="num"><input className="es-min" inputMode="decimal" aria-label={`Quantidade de ${nome(i.product_id)}`} defaultValue={String(i.quantidade).replace('.', ',')}
                    onBlur={(e) => { const q = parseNumero(e.target.value); if (q > 0) setItens(itens.map((x) => (x.product_id === i.product_id ? { ...x, quantidade: q } : x))); }} /></td>
                  <td className="num">{brl(Number(p.preco_custo || 0) * Number(i.quantidade))}</td>
                  <td className="num"><button type="button" className="btn-link perigo" onClick={() => setItens(itens.filter((x) => x.product_id !== i.product_id))}>Remover</button></td>
                </tr>
              );
            })}
            <tr><td colSpan={2} className="num"><b>Custo do combo</b></td><td className="num"><b>{brl(custoDoCombo(itens, produtos))}</b></td><td /></tr>
          </tbody>
        </table></div>
      )}
      <Field label="Adicionar produto ao combo">
        <ProdutoPicker produtos={elegiveis} onSelecionar={(p) => setItens([...itens, { product_id: p.id, quantidade: 1 }])} limparAoSelecionar placeholder="Buscar produto (ex.: X-Burguer, Batata, Refri)" />
      </Field>
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

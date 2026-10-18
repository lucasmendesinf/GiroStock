import { Link, useNavigate } from 'react-router-dom';
import { useLoja } from '../estado.jsx';
import { brl } from '../util';

// Preco: "De R$ X por" + preco; no varejo, as parcelas do cartao (ate o limite da loja).
export function Preco({ p, completo }) {
  const { loja } = useLoja();
  const pg = loja.pagamentos;
  const parcelas = loja.tipo !== 'cardapio' && pg.cartao_online && pg.parcelas_max > 1 ? pg.parcelas_max : 0;
  return (
    <span className="preco">
      {p.preco_original && <s>De {brl(p.preco_original)}{completo ? '' : ' por'}</s>}
      <b>{brl(p.preco)}</b>
      {parcelas > 0 && <small className="parcelas">em até {parcelas}x no cartão</small>}
    </span>
  );
}

const desconto = (p) => (p.preco_original ? Math.round((1 - p.preco / p.preco_original) * 100) : 0);

export default function CartaoProduto({ p }) {
  const { loja, adicionar, avisar } = useLoja();
  const navegar = useNavigate();
  const off = desconto(p);
  const foto = (
    <>
      {p.imagens[0] ? <img src={p.imagens[0]} alt="" loading="lazy" /> : <span className="sem-foto" aria-hidden="true">🛍</span>}
      {off > 0 && <span className="selo selo-off">-{off}%</span>}
      {!p.disponivel && <span className="selo selo-esgotado">Esgotado</span>}
    </>
  );
  // Cardapio: o cartao inteiro abre o item (complementos, observacao).
  if (loja.tipo === 'cardapio') {
    return (
      <Link to={`/produto/${p.id}`} className={`cartao ${p.disponivel ? '' : 'esgotado'}`}>
        <span className="cartao-foto">{foto}</span>
        <span className="cartao-info">
          <span className="cartao-nome">{p.nome}</span>
          {p.descricao && <span className="cartao-desc">{p.descricao}</span>}
          <Preco p={p} />
        </span>
      </Link>
    );
  }
  // Varejo: botao Comprar direto no cartao; produto com opcoes abre a pagina para escolher.
  function comprar() {
    if (p.complementos.length > 0) return navegar(`/produto/${p.id}`);
    adicionar({ product_id: p.id, nome: p.nome, imagem: p.imagens[0] || null, preco_unitario: p.preco, quantidade: 1, unidade: p.unidade, complementos: [], observacao: '', maximo: p.quantidade_maxima });
    avisar(`${p.nome} no carrinho`);
  }
  return (
    <div className={`cartao ${p.disponivel ? '' : 'esgotado'}`}>
      <Link to={`/produto/${p.id}`} className="cartao-foto" tabIndex={-1} aria-hidden="true">{foto}</Link>
      <div className="cartao-info">
        <Link to={`/produto/${p.id}`} className="cartao-nome">{p.nome}</Link>
        {p.descricao && <span className="cartao-desc">{p.descricao}</span>}
        <Preco p={p} />
        <button type="button" className="botao cartao-comprar" onClick={comprar} disabled={!p.disponivel}>
          {!p.disponivel ? 'Esgotado' : p.complementos.length > 0 ? 'Escolher' : 'Comprar'}
        </button>
      </div>
    </div>
  );
}

export function Grade({ produtos }) {
  return <div className="grade">{produtos.map((p) => <CartaoProduto key={p.id} p={p} />)}</div>;
}

// Prateleira: produtos lado a lado com rolagem (setas no computador).
export function Prateleira({ produtos }) {
  function rolar(e, lado) {
    const trilho = e.currentTarget.parentElement.querySelector('.prateleira-trilho');
    trilho.scrollBy({ left: lado * trilho.clientWidth * 0.9, behavior: 'smooth' });
  }
  return (
    <div className="prateleira">
      <button type="button" className="prateleira-seta esquerda" onClick={(e) => rolar(e, -1)} aria-label="Anteriores">‹</button>
      <div className="prateleira-trilho">{produtos.map((p) => <CartaoProduto key={p.id} p={p} />)}</div>
      <button type="button" className="prateleira-seta direita" onClick={(e) => rolar(e, 1)} aria-label="Próximos">›</button>
    </div>
  );
}

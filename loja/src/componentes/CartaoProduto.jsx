import { Link } from 'react-router-dom';
import { brl } from '../util';

export function Preco({ p }) {
  return (
    <span className="preco">
      {p.preco_original && <s>{brl(p.preco_original)}</s>}
      <b>{brl(p.preco)}</b>
    </span>
  );
}

export default function CartaoProduto({ p }) {
  const off = p.preco_original ? Math.round((1 - p.preco / p.preco_original) * 100) : 0;
  return (
    <Link to={`/produto/${p.id}`} className={`cartao ${p.disponivel ? '' : 'esgotado'}`}>
      <span className="cartao-foto">
        {p.imagens[0] ? <img src={p.imagens[0]} alt="" loading="lazy" /> : <span className="sem-foto" aria-hidden="true">🛍</span>}
        {off > 0 && <span className="selo selo-off">-{off}%</span>}
        {!p.disponivel && <span className="selo selo-esgotado">Esgotado</span>}
      </span>
      <span className="cartao-info">
        <span className="cartao-nome">{p.nome}</span>
        {p.descricao && <span className="cartao-desc">{p.descricao}</span>}
        <Preco p={p} />
      </span>
    </Link>
  );
}

export function Grade({ produtos }) {
  return <div className="grade">{produtos.map((p) => <CartaoProduto key={p.id} p={p} />)}</div>;
}

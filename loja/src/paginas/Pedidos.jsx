import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import { brl, dataHora } from '../util';

export default function Pedidos() {
  const { conta } = useLoja();
  const [lista, setLista] = useState(null);
  useEffect(() => { if (conta) api.get('/pedidos').then(setLista).catch(() => setLista({ pedidos: [] })); }, [conta]);
  if (!conta) return <Navigate to="/entrar?depois=/pedidos" replace />;
  return (
    <section className="bloco">
      <h1>Meus pedidos</h1>
      {!lista ? <div className="carregando" /> : lista.pedidos.length === 0 ? (
        <p className="vazio">Você ainda não fez pedidos. <Link to="/">Ver produtos</Link></p>
      ) : (
        <ul className="lista-pedidos">
          {lista.pedidos.map((p) => (
            <li key={p.id}>
              <Link to={`/pedidos/${p.id}`}>
                <span><b>Pedido #{p.numero}</b><small>{dataHora(p.criado_em)} · {p.itens} item(ns) · {p.tipo === 'entrega' ? 'entrega' : 'retirada'}</small></span>
                <span className="direita"><span className={`etiqueta etapa-${p.etapa}`}>{p.etapa_nome}</span><b>{brl(p.total)}</b></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

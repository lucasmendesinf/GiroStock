import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { temModulo } from '../utils/permissions.js';
import ListaProdutos from './produtos/ListaProdutos.jsx';
import Movimentacoes from './produtos/Movimentacoes.jsx';
import EntradaNota from './produtos/EntradaNota.jsx';
import Insumos from './produtos/Insumos.jsx';
import Complementos from './produtos/Complementos.jsx';

const ABAS = [
  { id: 'produtos', label: 'Produtos' },
  { id: 'estoque', label: 'Estoque & Movimentações' },
  { id: 'nota', label: 'Entrada por nota' },
  { id: 'insumos', label: 'Insumos' },
  { id: 'complementos', label: 'Complementos' },
];

// Dados compartilhados entre as abas; cada aba recarrega o que precisar via reload().
export default function Products() {
  const toast = useToast();
  const { user } = useAuth();
  // Sem o modulo Lanchonete nao ha insumos nem ficha tecnica: some a aba e nada de insumo e carregado.
  const lanchonete = temModulo(user, 'lanchonete');
  const abas = ABAS.filter((a) => a.id !== 'insumos' || lanchonete);
  const [params, setParams] = useSearchParams();
  const aba = abas.some((a) => a.id === params.get('aba')) ? params.get('aba') : 'produtos';
  const [dados, setDados] = useState({ products: [], categories: [], locations: [], suppliers: [], ingredients: [], alertas: [] });
  const [carregado, setCarregado] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [products, categories, locations, suppliers, ingredients, alertas] = await Promise.all([
        api.get('/products'), api.get('/categories'), api.get('/locations'), api.get('/suppliers'),
        lanchonete ? api.get('/ingredients') : Promise.resolve([]), api.get('/stock/alerts'),
      ]);
      setDados({ products, categories, locations, suppliers, ingredients, alertas });
      setCarregado(true);
    } catch (err) { toast.erro(err); }
  }, [toast, lanchonete]);

  useEffect(() => { reload(); }, [reload]);

  const props = { ...dados, reload, carregado, lanchonete };

  return (
    <div className="page">
      <h2>Produtos &amp; Estoque</h2>
      <div className="pe-tabs" role="tablist">
        {abas.map((a) => (
          <button key={a.id} role="tab" aria-selected={aba === a.id} className={`pe-tab ${aba === a.id ? 'active' : ''}`}
            onClick={() => setParams(a.id === 'produtos' ? {} : { aba: a.id })}>
            {a.label}{a.id === 'estoque' && dados.alertas.length > 0 ? ` (${dados.alertas.length})` : ''}
          </button>
        ))}
      </div>
      <div className="pe-tabpanel">
        {/* As abas so montam depois do primeiro carregamento: os padroes (loja, etc.) dependem dos dados. */}
        {!carregado && <p className="muted" style={{ padding: '16px 0' }}>Carregando...</p>}
        {carregado && aba === 'produtos' && <ListaProdutos {...props} />}
        {carregado && aba === 'estoque' && <Movimentacoes {...props} />}
        {carregado && aba === 'nota' && <EntradaNota {...props} />}
        {carregado && aba === 'insumos' && <Insumos {...props} />}
        {carregado && aba === 'complementos' && <Complementos {...props} />}
      </div>
    </div>
  );
}

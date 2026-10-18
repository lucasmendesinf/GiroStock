import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import Geral from './lojavirtual/Geral.jsx';
import Produtos from './lojavirtual/Produtos.jsx';
import Entrega from './lojavirtual/Entrega.jsx';
import Cupons from './lojavirtual/Cupons.jsx';
import Pagamentos from './lojavirtual/Pagamentos.jsx';
import Clientes from './lojavirtual/Clientes.jsx';

const ABAS = [
  { to: '/loja-virtual/geral', label: 'Visão geral' },
  { to: '/loja-virtual/produtos', label: 'Produtos no site' },
  { to: '/loja-virtual/entrega', label: 'Entrega' },
  { to: '/loja-virtual/cupons', label: 'Cupons' },
  { to: '/loja-virtual/pagamentos', label: 'Pagamentos' },
  { to: '/loja-virtual/clientes', label: 'Clientes do site' },
];

// Gerenciamento da loja virtual. O site (projeto separado, o mesmo para todas as empresas) le tudo pela API
// com a chave gerada aqui; os pedidos do site caem na tela de Pedidos.
export default function LojaVirtual() {
  const toast = useToast();
  const { pathname } = useLocation();
  const abasRef = useRef(null);
  const [dados, setDados] = useState(null);
  const recarregar = useCallback(() => api.get('/loja-virtual').then(setDados).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { recarregar(); }, [recarregar]);
  useEffect(() => {
    const ativa = abasRef.current && abasRef.current.querySelector('a.active');
    if (ativa && abasRef.current.scrollWidth > abasRef.current.clientWidth) {
      abasRef.current.scrollTo({ left: ativa.offsetLeft - (abasRef.current.clientWidth - ativa.offsetWidth) / 2, behavior: 'smooth' });
    }
  }, [pathname]);
  return (
    <div className="page">
      <div className="ped-head"><h2>Loja virtual</h2>{dados && <SituacaoLoja dados={dados} />}</div>
      <nav className="mt-abas" ref={abasRef} aria-label="Seções da loja virtual">
        {ABAS.map((a) => <NavLink key={a.to} to={a.to}>{a.label}</NavLink>)}
      </nav>
      {!dados ? <p className="muted">Carregando…</p> : (
        <Routes>
          <Route path="geral" element={<Geral dados={dados} onMudou={recarregar} />} />
          <Route path="produtos" element={<Produtos config={dados.config} />} />
          <Route path="entrega" element={<Entrega config={dados.config} onMudou={recarregar} />} />
          <Route path="cupons" element={<Cupons />} />
          <Route path="pagamentos" element={<Pagamentos config={dados.config} onMudou={recarregar} />} />
          <Route path="clientes" element={<Clientes />} />
          <Route path="*" element={<Navigate to="/loja-virtual/geral" replace />} />
        </Routes>
      )}
    </div>
  );
}

export function SituacaoLoja({ dados }) {
  const c = dados.config;
  const [cls, txt] = !c.publicada ? ['', 'Fora do ar'] : c.pausada ? ['warn', 'No ar · pausada'] : dados.situacao.ok ? ['ok', 'No ar · recebendo pedidos'] : ['warn', 'No ar · fechada agora'];
  return <span className={`ped-pill ${cls}`} title={dados.situacao.motivo || ''}>{txt}</span>;
}

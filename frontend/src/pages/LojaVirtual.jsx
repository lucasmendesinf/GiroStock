import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import Geral from './lojavirtual/Geral.jsx';
import Produtos from './lojavirtual/Produtos.jsx';
import Aparencia from './lojavirtual/Aparencia.jsx';
import Entrega from './lojavirtual/Entrega.jsx';
import Cupons from './lojavirtual/Cupons.jsx';
import Pagamentos from './lojavirtual/Pagamentos.jsx';
import Clientes from './lojavirtual/Clientes.jsx';
import PedidosSite from './lojavirtual/PedidosSite.jsx';

const ABAS = [
  { to: '/loja-virtual/geral', label: 'Visão geral' },
  { to: '/loja-virtual/pedidos', label: 'Pedidos do site', soVarejo: true },
  { to: '/loja-virtual/aparencia', label: 'Aparência' },
  { to: '/loja-virtual/produtos', label: 'Produtos no site' },
  { to: '/loja-virtual/entrega', label: 'Entrega' },
  { to: '/loja-virtual/cupons', label: 'Cupons' },
  { to: '/loja-virtual/pagamentos', label: 'Pagamentos' },
  { to: '/loja-virtual/clientes', label: 'Clientes do site' },
];

// Gerenciamento da loja virtual. O site e o mesmo para todas as empresas e e servido pelo proprio GiroStock no
// endereco da loja (subdominio ou dominio proprio, definidos pelo Master). Pedidos do site: loja online (varejo) na aba
// Pedidos do site; cardapio digital na tela de Pedidos.
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
        {ABAS.filter((a) => !a.soVarejo || !dados || dados.config.tipo !== 'cardapio').map((a) => (
          <NavLink key={a.to} to={a.to}>{a.label}{a.soVarejo && dados && dados.resumo.pedidos_a_despachar > 0 ? <span className="lv-contador">{dados.resumo.pedidos_a_despachar}</span> : null}</NavLink>
        ))}
      </nav>
      {!dados ? <p className="muted">Carregando…</p> : (
        <Routes>
          <Route path="geral" element={<Geral dados={dados} onMudou={recarregar} />} />
          <Route path="aparencia" element={<Aparencia key={dados.config.id} config={dados.config} onMudou={recarregar} />} />
          <Route path="produtos" element={<Produtos config={dados.config} />} />
          <Route path="entrega" element={<Entrega config={dados.config} onMudou={recarregar} />} />
          <Route path="cupons" element={<Cupons />} />
          <Route path="pagamentos" element={<Pagamentos config={dados.config} onMudou={recarregar} />} />
          <Route path="clientes" element={<Clientes />} />
          {dados.config.tipo !== 'cardapio' && <Route path="pedidos" element={<PedidosSite config={dados.config} onMudou={recarregar} />} />}
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

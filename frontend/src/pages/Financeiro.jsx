import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import Resumo from './financeiro/Resumo.jsx';
import Titulos from './financeiro/Titulos.jsx';
import Fluxo from './financeiro/Fluxo.jsx';
import Resultado from './financeiro/Resultado.jsx';
import Cadastros from './financeiro/Cadastros.jsx';
import { definirHoje } from './financeiro/util.jsx';

const ABAS = [
  { to: '/financeiro/resumo', label: 'Resumo' },
  { to: '/financeiro/pagar', label: 'Contas a pagar' },
  { to: '/financeiro/receber', label: 'Contas a receber' },
  { to: '/financeiro/fluxo', label: 'Fluxo de caixa' },
  { to: '/financeiro/resultado', label: 'Resultado do mês' },
  { to: '/financeiro/cadastros', label: 'Cadastros' },
];

// Financeiro: contas a pagar/receber, fluxo de caixa, resultado e cadastros (contas, formas, categorias).
export default function Financeiro() {
  const toast = useToast();
  const { pathname } = useLocation();
  const abasRef = useRef(null);
  const [opcoes, setOpcoes] = useState(null);
  const [versao, setVersao] = useState(0); // muda quando algo e lancado/pago: as outras abas recarregam
  const carregarOpcoes = useCallback(() => api.get('/financeiro/opcoes').then((o) => { definirHoje(o.hoje); setOpcoes(o); }).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { carregarOpcoes(); }, [carregarOpcoes]);
  const mudou = useCallback(() => { setVersao((v) => v + 1); carregarOpcoes(); }, [carregarOpcoes]);
  useEffect(() => {
    const ativa = abasRef.current && abasRef.current.querySelector('a.active');
    if (ativa && abasRef.current.scrollWidth > abasRef.current.clientWidth) {
      abasRef.current.scrollTo({ left: ativa.offsetLeft - (abasRef.current.clientWidth - ativa.offsetWidth) / 2, behavior: 'smooth' });
    }
  }, [pathname]);
  return (
    <div className="page">
      <div className="ped-head"><h2>Financeiro</h2></div>
      <nav className="mt-abas" ref={abasRef} aria-label="Seções do financeiro">
        {ABAS.map((a) => <NavLink key={a.to} to={a.to}>{a.label}</NavLink>)}
      </nav>
      {!opcoes ? <p className="muted">Carregando…</p> : (
        <Routes>
          <Route path="resumo" element={<Resumo versao={versao} />} />
          <Route path="pagar" element={<Titulos key="pagar" tipo="pagar" opcoes={opcoes} onMudou={mudou} />} />
          <Route path="receber" element={<Titulos key="receber" tipo="receber" opcoes={opcoes} onMudou={mudou} />} />
          <Route path="fluxo" element={<Fluxo versao={versao} />} />
          <Route path="resultado" element={<Resultado opcoes={opcoes} versao={versao} />} />
          <Route path="cadastros" element={<Cadastros onMudou={mudou} />} />
          <Route path="*" element={<Navigate to="/financeiro/resumo" replace />} />
        </Routes>
      )}
    </div>
  );
}

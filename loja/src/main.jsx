import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { BASE_ROTAS } from './api';
import { ProvedorLoja } from './estado.jsx';
import Layout from './componentes/Layout.jsx';
import Inicio from './paginas/Inicio.jsx';
import Produtos from './paginas/Produtos.jsx';
import Produto from './paginas/Produto.jsx';
import Carrinho from './paginas/Carrinho.jsx';
import Entrar from './paginas/Entrar.jsx';
import Finalizar from './paginas/Finalizar.jsx';
import Pedido from './paginas/Pedido.jsx';
import Pedidos from './paginas/Pedidos.jsx';
import Conta from './paginas/Conta.jsx';
import './estilos.css';

createRoot(document.getElementById('raiz')).render(
  <StrictMode>
    <BrowserRouter basename={BASE_ROTAS || undefined}>
      <ProvedorLoja>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Inicio />} />
            <Route path="produtos" element={<Produtos />} />
            <Route path="produto/:id" element={<Produto />} />
            <Route path="carrinho" element={<Carrinho />} />
            <Route path="entrar" element={<Entrar key="entrar" modo="entrar" />} />
            <Route path="cadastro" element={<Entrar key="cadastro" modo="cadastro" />} />
            <Route path="recuperar-senha" element={<Entrar key="recuperar" modo="recuperar" />} />
            <Route path="finalizar" element={<Finalizar />} />
            <Route path="pedidos" element={<Pedidos />} />
            <Route path="pedidos/:id" element={<Pedido />} />
            <Route path="conta" element={<Conta />} />
            <Route path="*" element={<Inicio />} />
          </Route>
        </Routes>
      </ProvedorLoja>
    </BrowserRouter>
  </StrictMode>,
);

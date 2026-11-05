import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Site da loja virtual: um app so para todas as lojas, servido pelo backend do GiroStock em /loja-assets
// (a loja e escolhida pelo endereco acessado). Em desenvolvimento: npm run dev e abrir /loja-previa/<subdominio>/.
export default defineConfig({
  base: '/loja-assets/',
  plugins: [react()],
  server: {
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
});

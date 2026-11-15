# Logomarca GiroStock (opção D3: duas setas em giro + caixa)

Arquivos prontos para uso. **Ainda não aplicados no sistema.**

| Arquivo | Uso |
|---|---|
| `marca-escuro.svg` / `marca-claro.svg` | Marca sozinha (sem nome), para fundo escuro / claro |
| `marca-uma-cor-claro.svg` / `marca-uma-cor-escuro.svg` | Marca em uma cor (cupom, carimbo, impressão P&B) |
| `logo-horizontal-escuro.svg/.png` / `logo-horizontal-claro.svg/.png` | Marca + "GiroStock" + "PDV · ESTOQUE" (texto em contornos, não depende de fonte) |
| `logo-horizontal-uma-cor-*.svg` | Versão horizontal em uma cor |
| `favicon.svg` | Favicon moderno (navegadores atuais) |
| `favicon.ico` (16, 32, 48) | Favicon de compatibilidade |
| `favicon-16.png`, `favicon-32.png` | Favicons em PNG |
| `apple-touch-icon.png` (180) | Ícone no iPhone/iPad |
| `icon-192.png`, `icon-512.png` | Ícones do aplicativo instalável (PWA) |
| `icon-512-maskable.png` | Ícone "maskable" do Android (com margem de segurança) |
| `icone-quadrado.svg` | Ícone com fundo quadrado cheio |
| `marca-escuro-512.png` | Marca em PNG com fundo transparente |

## Cores
Dourado `#d4ae4a` (claro `#e6c766`), vinho `#8a1c2b`, seta vinho no escuro `#c0394a`, fundo do ícone `#17161a`. Versão clara: dourado `#8f6810`, vinho `#7a1420`.

## Como aplicar (quando for autorizado)
1. Copiar os arquivos para `frontend/public/` (`favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`).
2. `frontend/index.html`, dentro do `<head>`:
```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon.ico" sizes="48x48" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
```
3. `frontend/vite.config.js`, no manifesto do `VitePWA` (hoje `icons: []`):
```js
icons: [
  { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
],
```
   e alinhar `theme_color`/`background_color` do manifesto a `#0f0e10` (hoje `#0f172a`).
4. Trocar o texto "GiroStock" do topo (`.brand` em `App.jsx`) e do login pela marca + nome (SVG inline ou `<img>`), e usar a versão de uma cor no cupom/comanda impressos.

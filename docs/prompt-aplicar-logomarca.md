# Prompt — Aplicar a logomarca e o favicon do GiroStock no sistema

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Os arquivos da logomarca **já estão prontos e aprovados** em `docs/logo/` (opção D3: duas setas em giro — dourada e vinho — ao redor de uma caixa). Leia `docs/logo/LEIAME.md`. **Não redesenhe a marca**; só aplique.

---

## 1. Objetivo

Colocar a logomarca nos lugares certos do **sistema**:
1. **Favicon** (aba do navegador) e **ícones do aplicativo instalável (PWA)** — hoje não há favicon e o manifesto está com `icons: []`.
2. **Marca + nome "GiroStock"** no topo do sistema (menu normal, modo PDV tela cheia e menu móvel) e na **tela de login** (e telas de 2FA / redefinir senha).
3. Garantir que a marca **acompanhe o tema** (claro/escuro).

**Não** colocar a logomarca no **cupom, na comanda da cozinha nem em qualquer documento impresso**: eles são da **empresa cliente** (usam o nome/cabeçalho configurado por ela), não da plataforma. Também **não** mexer na faixa de modo teste/suporte, nos textos dos arquivos de recuperação do 2FA nem em nada que não esteja listado aqui.

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador (`npm run dev` em `frontend` e `backend`), **nos dois temas e no celular (largura 375 px)**; build não basta.
- **Não quebre** o menu (incl. botão do menu móvel), o PDV em tela cheia, o login com 2FA, a faixa de aviso/teste/suporte e o tema claro/escuro.
- Não apague nem altere `docs/logo/` (fonte dos arquivos finais).

## 3. Estado atual (leia antes)

- `frontend/index.html`: sem `<link rel="icon">`; `theme-color` = `#0c0b0d`. Não existe `frontend/public/`.
- `frontend/vite.config.js`: `VitePWA` com `icons: []`, `theme_color` e `background_color` = `#0f172a` (azul antigo, não é da paleta atual).
- `src/App.jsx`: o texto `GiroStock` aparece em **dois** `<div className="brand">` — modo PDV (`topbar topbar-pdv`) e menu normal. CSS em `src/styles.css`: `.topbar .brand` (Playfair Display 800, 20 px, `var(--gold-light)`), altura do topo 84 px (64 px no móvel, onde `.topbar .brand { flex: 1 }`).
- `src/pages/Login.jsx`: `<h1>GiroStock</h1>` dentro de `.login-card` (linha ~149); as outras etapas (`Redefinir senha`, `Proteja sua conta`, `Código de verificação`) têm `<h1>` próprios. CSS: `.login-card h1`.
- Temas por `:root[data-theme="dark"|"light"]` em `styles.css` (paleta "dourado contido": `--bg`, `--panel`, `--ivory`, `--gold-light`, `--muted`…).

## 4. Arquivos da marca (já prontos, em `docs/logo/`)

`favicon.svg`, `favicon.ico`, `favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `marca-escuro.svg`, `marca-claro.svg`, `logo-horizontal-*.svg/.png`, versões de uma cor. Cores: tema escuro — seta 1 `#d4ae4a`, seta 2 `#c0394a`, caixa `#e6c766` (topo) / `#d4ae4a` (esquerda) / `#8a1c2b` (direita); tema claro — seta 1 `#8f6810`, seta 2 `#7a1420`, caixa `#a57a14` / `#8f6810` / `#7a1420`.

## 5. O que fazer

### 5.1 Favicon e PWA
1. Crie `frontend/public/` e **copie** de `docs/logo/`: `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`.
2. `frontend/index.html`, no `<head>`:
   ```html
   <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
   <link rel="icon" href="/favicon.ico" sizes="48x48" />
   <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
   ```
   e ajuste `theme-color` para `#0f0e10` (fundo atual do tema escuro).
3. `frontend/vite.config.js`, manifesto do `VitePWA`: `icons` com `icon-192.png` (192×192), `icon-512.png` (512×512) e `icon-512-maskable.png` (512×512, `purpose: 'maskable'`); `theme_color` e `background_color` = `#0f0e10`. Mantenha `name`, `short_name`, `start_url`, `display`. Confirme que os arquivos de `public/` entram no `dist/` e no pré-cache do service worker (ou, se for um problema, deixe só em `public`).
4. Atenção ao cache: `registerType: 'autoUpdate'` já atualiza o service worker; teste que, após o build, o favicon novo aparece (limpando o cache do navegador se necessário) e **diga no relatório** se algum visitante precisa recarregar à força.

### 5.2 Componente da marca
Crie `src/components/Logo.jsx`:
- `<Marca tamanho={40} />`: SVG **inline** (viewBox `0 0 64 64`) com as duas setas e a caixa, usando **variáveis CSS** para as cores (ex.: `--logo-seta-1`, `--logo-seta-2`, `--logo-caixa-topo`, `--logo-caixa-esq`, `--logo-caixa-dir`), definidas **em `styles.css`** para `:root[data-theme="dark"]` e `:root[data-theme="light"]` com os valores da seção 4 — assim troca de tema sem recarregar e sem duplicar o SVG. Use as mesmas coordenadas de `docs/logo/marca-escuro.svg` (copie os elementos de lá, trocando os `fill`/`stroke` por `var(--…)`). `aria-hidden="true"` quando houver o nome ao lado.
- `<Logo tamanho={..} legenda={false} />`: a marca + o nome **como texto HTML** ("Giro" na cor `var(--ivory)` e "Stock" em `var(--gold-light)`, fonte Playfair Display 800, mesmo estilo do `.brand` atual), com legenda opcional "PDV · ESTOQUE" (Manrope 700, caixa alta, espaçamento de letras, cor `var(--muted-2)`). Texto como HTML (não SVG) para continuar acessível e acompanhar o tema.
- Para o tema, a classe/atributo `data-theme` já existe em `:root`; não crie outro mecanismo.

### 5.3 Topo do sistema (`App.jsx` + `styles.css`)
- Substitua os dois `<div className="brand">GiroStock</div>` por `<div className="brand"><Logo tamanho={36} /></div>` (menu normal e modo PDV). O elemento continua com a classe `brand` para não quebrar os estilos de layout (`flex`, móvel).
- Marca de **~36 px** no desktop e **~30 px** no móvel (topo de 64 px); texto "GiroStock" mantém o tamanho atual. Sem legenda "PDV · ESTOQUE" no topo (só no login).
- Clicar na marca leva à tela inicial do usuário (use a mesma lógica de `rotaInicial(user)` que o login usa); no modo PDV **não** navegue (evita sair do PDV sem querer) — apenas mostra a marca.
- Verifique que a altura do topo, o alinhamento vertical com o menu, o botão do menu móvel e a faixa de aviso/teste/suporte **não mudam** nem "pulam".

### 5.4 Login (`pages/Login.jsx` + `styles.css`)
- No `<h1>GiroStock</h1>` da etapa principal, use `<Logo tamanho={64} legenda />` centralizado acima do formulário (marca maior + nome + legenda "PDV · ESTOQUE"), mantendo o `<h1>` semântico (pode envolver o `Logo` ou manter `<h1>` visualmente oculto "GiroStock" para leitores de tela).
- Nas etapas "Redefinir senha", "Proteja sua conta" e "Código de verificação", mostre **só a marca pequena** (`<Marca tamanho={40} />`) acima do título, sem alterar os textos.
- O cartão não pode crescer a ponto de quebrar o layout em 375 px; teste com e sem mensagem de erro.

### 5.5 Outros lugares (apenas conferir)
- Procure outros usos do nome/identidade (`grep -rni "girostock" frontend/src`): páginas como `/master`, mensagens de sistema, tela de "sem acesso", tela de manutenção (`manutencao`). Onde houver o **título de marca** visível ao usuário (não chaves de `localStorage` nem textos de arquivos), use `<Logo>` coerentemente; **liste no relatório** o que encontrou e decidiu.
- `docs/` e README: nada a fazer.

## 6. Testes obrigatórios (rodar e mostrar o resultado)

1. `npm run build` no `frontend` sem erros; `dist/` contém `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` e `manifest.webmanifest` com os 3 ícones e as cores novas.
2. No navegador: aba mostra o **favicon novo** (em aba clara e escura se possível); requisição de `/favicon.svg` e `/favicon.ico` = 200; `manifest.webmanifest` válido (DevTools > Application: ícones carregam e o app é "instalável").
3. Topo do sistema nos **dois temas**: marca legível e com as cores certas; troca de tema muda as cores **sem recarregar**; sem "pulo" de layout.
4. **Modo PDV tela cheia**: marca aparece, clicar nela **não** sai do PDV.
5. **Móvel (375 px)**: topo de 64 px, botão do menu móvel funcionando, marca + nome sem estourar, menu abre e fecha.
6. **Login** (claro/escuro, com e sem erro) e as etapas de 2FA/redefinição: marca grande no login, pequena nas demais; nada quebra; fluxo de login continua funcionando (inclusive com 2FA).
7. Cupom e comanda **inalterados** (confira a prévia/impressão: nenhuma logomarca da plataforma).
8. Faixas de aviso global, modo teste e suporte continuam alinhadas ao topo.
9. Acessibilidade básica: o nome "GiroStock" continua lido por leitor de tela (texto real, não só imagem); `aria-hidden` apenas no SVG decorativo.

## 7. Ordem sugerida de commits

1. `public/` + `index.html` + manifesto PWA (favicon e ícones). 2. Componente `Logo.jsx` + variáveis de cor por tema. 3. Topo do sistema (normal, PDV, móvel). 4. Login e etapas de 2FA. 5. Ajustes finais (outros usos encontrados, responsivo, tema).

## 8. Entrega

Rode os testes da seção 6 e faça um **relatório em português**: o que foi feito por commit, onde a marca foi aplicada, decisões tomadas, o que ficou de fora de propósito (cupom/comanda), problemas de cache de favicon, pendências e qualquer funcionalidade existente que você **não removeu** mas notou conflito. Inclua capturas de tela (claro/escuro, desktop/móvel) se possível.

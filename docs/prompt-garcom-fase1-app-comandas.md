# Prompt — Garçom, Fase 1/3: Perfil Garçom e app de comandas (mesa e pista)

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Modelo visual **validado pelo cliente**: `docs/garcom-preview/preview-garcom.html` (aba **App do garçom**). Sirva e clique em tudo:
> ```bash
> cd docs/garcom-preview && npx --yes serve -l 8092 .      # ou: python -m http.server 8092
> ```
> Fases: **1 Perfil e app de comandas (este)** → 2 Receber na hora e prestação de contas → 3 Comissões. Faça **somente a Fase 1**. Na Fase 1 **não** há recebimento pelo garçom nem comissão: o caixa fecha a comanda como hoje.

---

## 1. Objetivo

Garçons da casa de show trabalham **no celular**, na pista e nas mesas:
1. Novo **perfil "Garçom"** (e módulo **"Garçom e comandas"** liberável por plano/empresa), que só enxerga o app do garçom.
2. **Comanda** de **mesa** ou **pista** (cliente avulso por pulseira/cartão, nome opcional), com **várias rodadas** de pedido ao longo da noite. Cada rodada vai à cozinha/bar e **reserva estoque**.
3. O garçom **pede o fechamento**; o **caixa** abre a comanda, cobra e finaliza (gera **uma venda** com todos os itens). A comanda e cada item guardam **qual garçom lançou** (base para a comissão da Fase 3).

Decisões já tomadas (não rediscutir):
- A comissão é por **usuário** e vem na Fase 3; aqui só **registre o garçom por item** (`order_items.garcom_id`) e por rodada.
- O garçom **só vê as próprias comandas**; administrador/gerente/caixa veem todas da loja.
- **Sem desconto, cancelamento de venda, caixa, estoque, relatórios, cadastros** para o perfil Garçom.
- Pista avulsa **não exige cadastro de cliente**.

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador **em tela de celular (375 px)** e por requisições reais; build não basta.
- Antes de criar migrations: `ls backend/src/db/migrations` e use o **próximo número livre** (a última conhecida é `028_financeiro.sql`).
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Não quebre** PDV, Pedidos (quadro e cozinha), vendas, caixa, estoque/reserva, clientes, financeiro, Master, modo teste e suporte. Teste a venda direta e um pedido de mesa existentes depois de cada etapa.
- Estilo: paleta atual, temas claro e escuro, sem gradientes antigos. Toda consulta filtra por `tenant_id`; use `assertLocationAccess`/`filtroLocais` como o resto do sistema.

## 3. Estado atual (leia antes de codar; confirme no código)

- **Pedidos** (`routes/orders.routes.js`, `services/pedidos.js`, `pages/Pedidos.jsx`, `components/PedidoForm.jsx`): `orders` (`tipo` `retirada|entrega|mesa`; para mesa o nome da mesa fica em `orders.endereco`), `order_items`, `order_status_log`; fluxo `novo → em_preparo → pronto → (saiu_entrega) → finalizado`; **estoque reservado** ao criar (calculado sobre pedidos em aberto: status ≠ `finalizado`/`cancelado`); **finalizar o pedido gera a venda** (`registrarVenda` em `services/vendas.js`, que exige `terminal_id` com **caixa aberto**). `criado_por` registra quem criou.
- **Permissões** (`middleware/permissions.js`): `MATRIX` por perfil, `PERMISSOES` (ajustáveis por usuário), `areasEfetivas`. Perfis atuais em `user_role` (enum) e na lista `PERFIS` de `routes/users.routes.js`/`Users.jsx`.
- **Módulos por plano** (`backend/src/config/modulos.js`): `pdv`, `lanchonete`, `pedidos` (requer `pdv`), `clientes`, `delivery_apps`, `eventos` (ainda não disponível)… O Master liga/desliga por plano/empresa; módulo desligado desliga as `areas` dele.
- Reserva de estoque, ficha técnica/insumos, complementos/combos e **comanda da cozinha impressa** já existem (reaproveite; não duplique). `scripts/e2e-*.mjs` são os testes de ponta a ponta.

## 4. Desenho recomendado (adapte ao código real e **justifique desvios no relatório**)

Conceitos: **comanda** (a conta da mesa/pista, aberta a noite toda) e **rodada** (cada envio de itens ao bar/cozinha). Reaproveite `orders` para a **rodada** (assim a cozinha, a reserva de estoque e a impressão já funcionam) e crie a comanda por cima:

- `comandas`: `id, tenant_id, location_id, numero (sequencial por loja), tipo ('mesa'|'pista'), identificador (ex.: "Mesa 7", "Pulseira 118"), cliente_nome (opcional), modo_pagamento ('conta'|'hora'  — usado na Fase 2; grave desde já, padrão 'conta'), status ('aberta'|'fechamento_solicitado'|'paga'|'cancelada'), aberta_por (user), aberta_em, fechamento_solicitado_em, fechada_em, fechada_por, sale_id, observacao`. Índice por tenant/loja/status; **uma comanda aberta por mesa** (índice único parcial em `identificador` para mesa).
- `orders`: `comanda_id` (nulo para pedidos normais), `rodada INT`; `tipo` passa a aceitar `pista` (refaça o CHECK como a migration `015_pedido_mesa.sql` fez) e `endereco` guarda o identificador; novo status **`entregue`** para rodadas de comanda (**não** `finalizado`: rodada de comanda **não gera venda** ao ser entregue).
- **Invariantes críticos**:
  1. `entregue` **continua contando como reservado** na consulta de reserva (senão dá para vender o que já foi servido e ainda não foi baixado). Ajuste a consulta de reserva/disponível e teste.
  2. Rodada de comanda **nunca** chama `registrarVenda` ao mudar de status; a **venda única** é criada **no fechamento da comanda** (seção 5.3), com todos os itens das rodadas não canceladas, e só então o estoque/insumos são **baixados** e as rodadas passam a `finalizado` (ligadas ao `sale_id`).
  3. Cancelar uma rodada ou item libera a reserva (como hoje).
- `order_items.garcom_id UUID REFERENCES users(id)` (garçom que lançou o item; padrão = quem enviou a rodada; **preservado** mesmo se a comanda for transferida depois).
- Fluxo da rodada para a cozinha/bar: aparece no quadro de **Pedidos** (cozinha) com etiqueta "Mesa 7 · rodada 2 · Marcos" (ou "Pista 118"), seguindo `novo → em_preparo → pronto → entregue`. Quem prepara marca "entregue" (ou o próprio garçom, ver 5.2).

## 5. O que fazer

### 5.1 Perfil, permissões e módulo
- Migration própria para `ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Garçom'` (**separada** de qualquer uso do valor; o PostgreSQL não permite usar o valor novo na mesma transação). Inclua `'Garçom'` em `PERFIS` (`users.routes.js`) e no seletor de `Users.jsx`.
- `MATRIX['Garçom']`: **todas** as áreas atuais `false`, exceto a nova `Garcom: true`. Acrescente nas demais linhas `Garcom` (Administrador/Gerente `true`; os outros `false`).
- Novas áreas em `PERMISSOES` (ajustáveis por usuário): `Garcom` ("Garçom: usar o app de comandas no celular"). (`ReceberNoApp` e `Comissoes` entram nas Fases 2 e 3: **não** crie agora.)
- Novo módulo em `config/modulos.js`: `garcom` — "Garçom e comandas", `padrao: false`, `disponivel: true`, `requer: ['pedidos']`, `areas: ['Garcom']`. Respeite como o Master mostra/liga módulos (telas de planos e empresas já listam os módulos automaticamente? confirme; se houver lista fixa no front, inclua o novo).
- Garçom **não** é Master/Administrador: ele só enxerga as comandas em que `aberta_por` é ele **ou** que tenham itens dele (`garcom_id`).

### 5.2 Back-end (`routes/garcom.routes.js`, registrar em `app.js`; checar `requireArea('Garcom')` e o módulo)
- `GET /garcom/comandas` — minhas comandas abertas (garçom) / todas da loja (quem tem `Pedidos`/gerência), com totais, nº de rodadas, itens não enviados não existem no servidor (rascunho fica no celular), situação (`aberta`, `fechamento_solicitado`).
- `POST /garcom/comandas` `{ tipo: 'mesa'|'pista', identificador, cliente_nome?, location_id? }` — abre; mesa já aberta → devolve a existente (garçom continua nela). Loja = a do usuário (garçom vinculado a uma loja; várias lojas → exige `location_id` permitido). Pista: identificador obrigatório (pulseira/cartão), nome opcional.
- `GET /garcom/comandas/:id` — detalhe (rodadas com itens e status da cozinha, totais).
- `POST /garcom/comandas/:id/rodadas` `{ itens: [{ product_id, quantidade, observacao?, complementos? }], observacao? }` — cria a **rodada** como pedido de comanda (reaproveite `services/pedidos.js`: valida disponibilidade/ficha técnica/complementos, **reserva estoque**, 409 "Sem estoque disponível de X"), grava `garcom_id` nos itens, imprime/gera a comanda da cozinha como hoje. Só comanda `aberta`. Idempotência: aceite um `client_id` (UUID gerado no celular) e ignore reenvios repetidos (essencial com sinal ruim).
- `POST /garcom/rodadas/:orderId/status` — garçom marca **entregue** na própria rodada quando `pronto` (cozinha continua mexendo pelo quadro de Pedidos). Cancelar rodada/itens: só **antes** de `em_preparo`, pelo próprio garçom; depois disso só gerente (`CancelarVendas`-like) com motivo.
- `POST /garcom/comandas/:id/pedir-fechamento` — status `fechamento_solicitado`, registra a hora e **avisa o caixa** (aparece destacada na lista de comandas do caixa; sem push por ora). Recusa se houver rodada ainda `novo/em_preparo` sem entrega? **Não bloqueie**: apenas avise na resposta.
- `POST /garcom/comandas/:id/transferir` `{ para_user_id }` — transfere a comanda a outro garçom da mesma loja; `aberta_por` muda, **os `garcom_id` dos itens já lançados NÃO mudam**. Auditoria.
- `POST /garcom/comandas/:id/reabrir` (gerente) — volta de `fechamento_solicitado` para `aberta`.

### 5.3 Caixa: fechar a comanda (usuário com `Vendas`; PDV/Pedidos)
- `GET /comandas` (listagem do caixa/gerência, filtro por status/loja/identificador) e `GET /comandas/:id`.
- `POST /comandas/:id/fechar` `{ terminal_id, forma_pagamento, valor_recebido?, desconto? }` — numa **transação**: soma os itens de todas as rodadas **não canceladas**, cria **uma venda** via `registrarVenda` (reaproveite; informe os itens agrupados; desconto só para quem tem `Desconto`), marca as rodadas `finalizado` com o `sale_id`, comanda `paga` com `sale_id`/`fechada_por`/`fechada_em`, **baixa estoque/insumos** (a reserva vira baixa) e audita. Sem caixa aberto no terminal → 409 claro. `forma_pagamento` única nesta fase (pagamento dividido vem na Fase 2).
- Cancelar comanda sem consumo (gerente): cancela rodadas abertas, libera reserva, motivo obrigatório.
- Front (caixa): aba/lista **"Comandas"** (no módulo Pedidos ou PDV, onde fizer mais sentido), com busca por mesa/pulseira, destaque das que **pediram fechamento**, tela de detalhe com itens por rodada e botão **"Receber e fechar"** que reaproveita o modal de pagamento do PDV.

### 5.4 Front-end do garçom (mobile-first; `pages/Garcom*.jsx` ou `pages/garcom/`)
Seguir o preview (**sem** o sheet "Receber agora", que é a Fase 2). Rota `/garcom` (e subrotas), disponível só para quem tem a área `Garcom` com módulo ligado; `rotaInicial` do perfil Garçom = `/garcom`; menu superior **mínimo** (marca, nome, tema, sair; sem as demais telas). Layout otimizado para 360–430 px, botões grandes, rolagem suave.
- **Início**: nome do garçom, minhas comandas (mesa/pista, nº de rodadas, total, "n itens não enviados"), botão **+ Nova comanda**, atalho "Meu extrato" (lista das comandas fechadas na noite e seus totais, **sem comissão** ainda).
- **Nova comanda**: grade de mesas (as já abertas destacadas) e bloco **Pista** (nº da pulseira/cartão, nome opcional).
- **Comanda**: busca + categorias + grade de produtos (preço, produtos sem estoque desabilitados com aviso), carrinho da **nova rodada** (mais/menos, observação por item e geral, complementos/combos se existirem no produto), **rodadas enviadas** com hora e situação (na cozinha / pronta / entregue), total da comanda, botão **"Enviar pedido ao bar/cozinha"** (confirma, mostra erro de estoque do servidor) e **"Pedir fechamento"**. Enviar gera `client_id` e **reenvia** em caso de falha de rede sem duplicar.
- **Rascunho local**: o carrinho da rodada não enviada fica em `localStorage` por comanda (não perde ao fechar o app/trocar de aba) e é limpo ao enviar. Aviso claro "sem conexão" e botão de tentar de novo. (Fila offline completa é **etapa futura**.)
- PWA: o manifesto atual deve permitir "Adicionar à tela inicial"; **não** quebre o PWA existente.

### 5.5 Gestão
- Em **Usuários**, criar usuário com perfil **Garçom** (loja obrigatória), ajustar a permissão `Garcom` por usuário; garçom não aparece como operador de caixa.
- Cupom/comanda da cozinha das rodadas mostram "Mesa 7 · rodada 2 · Garçom Marcos". **Não** altere o cupom fiscal/venda além de incluir a comanda de origem se for simples.

## 6. Testes obrigatórios (rodar e mostrar o resultado)

Crie `backend/scripts/e2e-garcom-fase1.mjs` (padrão dos e2e existentes) e teste no navegador (375 px):

1. Perfil Garçom: login redireciona para `/garcom`; não acessa `/api/sales`, caixa, relatórios, produtos (cadastro), usuários (403); só vê as próprias comandas; outro garçom não vê a comanda dele (404/403).
2. Abrir mesa (reabrir a mesma devolve a existente), abrir pista com pulseira; pista sem identificador → 400.
3. Rodada: reserva estoque (o disponível cai); **dois garçons lançando o último item** → o segundo recebe 409; reenvio com o mesmo `client_id` **não duplica**; produto com ficha técnica reserva insumos.
4. Cozinha vê a rodada no quadro de Pedidos com a etiqueta; `entregue` **mantém a reserva** (invariante 1); a rodada de comanda **não** gera venda sozinha (invariante 2).
5. Pedir fechamento marca a comanda e aparece destacada para o caixa; garçom não consegue adicionar rodada depois (ou só se reaberta).
6. Fechar no caixa: **uma venda** com todos os itens, estoque/insumos baixados **uma única vez**, caixa recebe (dinheiro conta no esperado do caixa), comanda `paga`, rodadas `finalizado`; sem caixa aberto → 409; desconto exige permissão.
7. Transferir comanda: `garcom_id` dos itens antigos **não muda**.
8. Cancelar rodada antes do preparo libera a reserva; depois do preparo exige gerente.
9. Módulo desligado na empresa: perfil Garçom/área `Garcom` indisponíveis (rotas 403, menu some). Empresas existentes não mudam.
10. Isolamento entre empresas e entre lojas (`filtroLocais`).
11. Regressão: pedidos de mesa/retirada/entrega existentes, PDV, caixa, relatórios, estoque, clientes, financeiro, Master, modo teste, suporte e os `npm run test:e2e*` existentes. Temas claro e escuro; layout sem rolagem horizontal em 375 px.

## 7. Fora do escopo (próximas fases)

Recebimento pelo garçom (Pix/cartão/dinheiro), pagamento parcial/dividido, prestação de contas, taxa de serviço, comissões, extrato com comissão, integração com maquininha, fila offline completa, roteamento de impressão por setor (bar × cozinha), pulseira com saldo/consumo mínimo.

## 8. Ordem sugerida de commits

1. Migrations (perfil/enum, `comandas`, colunas em `orders`/`order_items`, tipo `pista`, status `entregue`) + ajuste da reserva. 2. Perfil/áreas/módulo e `Users.jsx`. 3. Rotas do garçom (comandas e rodadas). 4. Fechamento no caixa e lista "Comandas". 5. Front do garçom (início, nova comanda, comanda). 6. Rascunho local, idempotência e ajustes mobile. 7. e2e e temas.

## 9. Entrega

Rode os testes da seção 6 e faça um **relatório em português**: o que foi feito por commit, decisões e **desvios do desenho recomendado** (com o motivo), resultados (inclusive falhas), pendências e qualquer funcionalidade existente que você **não removeu** mas notou conflito. Descreva como criar um usuário Garçom e testar no celular (rede local).

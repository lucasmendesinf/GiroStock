# Prompt — Cardápio digital para o cliente final (estilo iFood/99Food): lista contínua, categorias que acompanham a rolagem, login por telefone e pagamento online ou na entrega

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Modelo visual **validado pelo cliente**: `docs/cardapio-preview/preview-cardapio.html`. Sirva e clique em tudo (abra pelo **celular ou com a janela estreita**; no computador há um painel lateral só do preview):
> ```bash
> cd docs/cardapio-preview && npx --yes serve -l 8090 .      # ou: python -m http.server 8090
> ```
> Inspiração: o cardápio de apps de delivery (capa com logo redonda, produtos com foto e selo "% OFF", barra de categorias fixa no topo). **Mesa e garçom não fazem parte deste modelo** (é só para o cliente final, entrega ou retirada).

---

## 1. Objetivo

Evoluir o site da **loja virtual do tipo "Cardápio digital"** (`lv_lojas.tipo = 'cardapio'`, site em `loja/`) para este modelo:

1. **Uma página só**: capa + perfil da loja e **todos os produtos numa rolagem contínua**, agrupados por categoria (hoje o cardápio abre "Início" com blocos e cada categoria vai para outra página).
2. **Barra de categorias fixa no topo**: ao rolar, a **categoria atual acende sozinha** e a barra acompanha; tocar numa categoria rola até ela. Categoria **"Promoções"** automática (produtos com preço promocional).
3. **Cartões de produto** com foto, nome, descrição (2 linhas), preço antigo riscado, preço atual, **selo "% OFF"** e botão **+**; toque abre a folha do produto (adicionais, observação, quantidade).
4. **Entrega ou retirada** com taxa por bairro, pedido mínimo e tempo estimado.
5. **Pagamento**: online (**Pix, cartão de crédito, cartão de débito**) **ou** na entrega/retirada (**dinheiro com troco, cartão de crédito, cartão de débito, Pix**) — "se não paga online, paga na entrega".
6. **Login por telefone + código** (sem senha), pedido só na hora de **finalizar** ou ao abrir o **histórico**; **navegar e montar a sacola não exigem conta**.

Decisões já tomadas pelo cliente (não rediscutir):
- Sem mesa/garçom/comanda neste modelo.
- Sem agendamento de pedido.
- Pagamento: todos os métodos acima; o que não for pago online é pago na entrega/retirada.
- Login: **telefone e código** (a conta é o telefone).
- O modelo existente do **varejo/e-commerce** (`tipo = 'varejo'`) **não pode ser alterado**.

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide **no celular (375 px)** e no desktop, com a loja de teste e simuladores (Mercado Pago em `scripts/mercadopago-simulador.mjs`); build não basta.
- Antes de criar migrations: `ls backend/src/db/migrations` e use o **próximo número livre** (a última conhecida é `035_grades_variacoes.sql`).
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`; o site é um projeto à parte (`cd loja && npm install && npm run build`).
- **Não quebre** loja virtual varejo, pedidos do site na tela Pedidos, pagamento online (Mercado Pago), cupons, frete (Melhor Envio no varejo), clientes, PDV, iFood/99Food, Master. Rode `backend/scripts/e2e-loja-virtual.mjs` (com os simuladores) e **compare com o que passava antes** (conhecidas: algumas verificações de site por domínio/rastreio já falhavam em ambiente local antes deste trabalho).
- Segurança: limites de tentativas, nada de segredos em log/resposta; códigos de login **nunca** em log em produção.
- Estilo do site: as cores vêm do tema da loja (`aplicarTema`, variáveis `--primaria`, `--fundo`…), com claro/escuro como hoje.

## 3. Estado atual (leia antes; confirme no código)

- Site `loja/` (React/Vite): `componentes/Layout.jsx` (cardápio: `topo-cardapio`, `info-cardapio`, menu inferior Início/Pedidos/Conta), `paginas/Inicio.jsx` (blocos por tema), `Produtos.jsx` (categoria/busca em página separada, com `Grade`), `CartaoProduto.jsx`, `Produto.jsx`, `Carrinho.jsx`, `Finalizar.jsx`, `Entrar.jsx`, `Conta.jsx`, `Pedidos.jsx`, `estado.jsx`, `util.js` (`aplicarTema`).
- API pública `backend/src/routes/loja.publica.routes.js` (`/api/loja/v1`): `GET /loja`, `/categorias`, `/produtos`, `/produtos/:id`, `POST /carrinho`, `/frete`, **conta por e-mail e senha** (`/conta/cadastro`, `/conta/login`, esqueci/redefinir senha, `/conta`, `/conta/enderecos`), `POST /pedidos` (entrega/retirada, cupom, pagamento online), `GET /pedidos`, `POST /pedidos/:id/pagamento`, `POST /pedidos/:id/cancelar`. Há `limitar(...)` (rate limit) e `comConta`.
- Dados (`029_loja_virtual.sql` e seguintes): `lv_lojas` (nome, logo, `banners`, telefone/whatsapp/endereço, horários, `aceita_retirada/entrega`, `pedido_minimo`, **`pagamentos` JSONB** `{pix_online, cartao_online, na_entrega:[...]}`, `tipo`, `tema`), `lv_produtos` (produto publicado, foto, descrição, **preço promocional**), `lv_categorias`, `lv_regioes` (bairros e taxas), `lv_contas` (**nome, e-mail NOT NULL, telefone NOT NULL, senha_hash NOT NULL**, `customer_id` ligado a **Clientes** pelo telefone, `aceita_mensagens`, tokens de reset), `lv_enderecos`, `lv_pagamentos` (tentativas no Mercado Pago). Pedido do site = `orders` com `origem 'loja_virtual'`, `lv_fluxo`, `pagamento_online` (`'pix'|'cartao'`) e `pagamento_status`; a tela **Pedidos** já recebe esses pedidos e **bloqueia iniciar o preparo** enquanto o pagamento online não for aprovado.
- Complementos/adicionais existem no sistema (`grupos_complementos`, grupos por produto, `services/consumo.js`); **confirme se a API pública já expõe os grupos de um produto**; se não, exponha (veja 5.1).
- Mercado Pago só tem **Pix e cartão (crédito)**; **débito online depende do provedor** (ver 5.3).
- `services/email.js` envia e-mail; **não existe** serviço de WhatsApp/SMS no sistema (mensagens hoje são links `wa.me`).

## 4. Banco de dados (migrations com o próximo número livre)

- **Capa da loja**: `lv_lojas.capa_id UUID REFERENCES lv_imagens(id)` (imagem larga do topo do cardápio; editável na tela de gestão da loja virtual, onde hoje se envia logo/banners).
- **Contas por telefone**: `lv_contas.email` e `senha_hash` passam a ser **NULL permitidos**; garantir **telefone único por loja/empresa** (só dígitos normalizados, índice único parcial); contas antigas **continuam funcionando** (e-mail+senha no varejo) e também podem entrar por código no cardápio (o telefone já existe). Nome continua obrigatório (pedido no primeiro login).
- `lv_login_codigos`: `id, tenant_id, telefone (dígitos), codigo_hash, expira_em, tentativas INT, enviado_via, ip, criado_em, usado_em`; índice por telefone e expiração; limpeza periódica de vencidos.
- **Formas de pagamento da loja**: `lv_lojas.pagamentos` ganha granularidade sem quebrar o formato atual: `{ pix_online, cartao_online (crédito), debito_online, na_entrega: ['dinheiro','pix','cartao_credito','cartao_debito'] }` (migrar o valor antigo `'cartao'` de `na_entrega` para `cartao_credito` + `cartao_debito`). `orders.pagamento_online` passa a aceitar também `'debito'` (ajuste o CHECK). Para pagamento **na entrega**, gravar a forma escolhida e o **troco** (`orders.forma_pagamento_prevista` já existe; acrescente `troco_para NUMERIC(12,2)` se não houver).
- Provedor de código: tabela/config global com o provedor ativo (ver 5.2) — se já houver `config_global`, use-a; **segredos só em variáveis de ambiente**.

## 5. O que fazer

### 5.1 API pública (`/api/loja/v1`)
- `GET /cardapio`: devolve **tudo de uma vez** para a página única — loja (nome, logo, **capa**, aberta/fechada e horário, tempo estimado, pedido mínimo, formas de pagamento, bairros/taxas), e as **seções** (categorias na ordem do cadastro; **"Promoções"** automática no topo com os itens que têm preço promocional; produtos com `id`, nome, descrição curta, foto, preço, preço promocional, `% off` calculado, disponibilidade pelo estoque, e se têm **grupos de adicionais**). Paginação **não** (cardápio completo, com cache `ETag`/curto e imagens em tamanho adequado/lazy). Produtos sem estoque aparecem **indisponíveis** (como já ocorre) e não podem ser adicionados.
- `GET /produtos/:id` passa a incluir os **grupos de adicionais** (nome, mínimo, máximo, opções com preço) se ainda não incluir; o **carrinho/pedido** valida mínimo/máximo e preço **no servidor** (reaproveite `validarComplementos`/`precoDosComplementos` de `services/consumo.js`) e grava os complementos no item.
- **Login por telefone**: 
  - `POST /conta/codigo` `{ telefone }` — valida o telefone (DDD + 8/9 dígitos), aplica **limites** (ex.: 3 códigos por telefone/15 min, 10 por IP/h), gera código de **6 dígitos** aleatório seguro, guarda **só o hash**, validade **10 min**, envia pelo provedor (5.2) e responde sempre igual (não revelar se o telefone já existe).
  - `POST /conta/entrar` `{ telefone, codigo, nome? }` — confere o hash em tempo constante, **máx. 3 tentativas por código** (depois invalida), uso único. Se o telefone **já tem conta** → entra (devolve o token no formato atual de `/conta/login`); se **não tem**, exige `nome` (resposta indica `precisa_nome: true` sem consumir o código) e cria a conta (ligando/criando o **cliente** em Clientes pelo telefone, como o cadastro atual faz), com o consentimento de mensagens vindo do campo `aceita_mensagens` informado.
  - Sessões: mesmo mecanismo de token atual (`sessoes_validas_desde`, expiração); **encerrar sessões** continua funcionando. Os endpoints antigos (`/conta/login` com senha) **permanecem** para o varejo.
- **Pedido** (`POST /pedidos`): aceita `pagamento: { quando: 'online'|'entrega', forma: 'pix'|'cartao_credito'|'cartao_debito'|'dinheiro', troco_para? }`; valida contra o que a loja habilitou; `online` segue o fluxo atual (Pix: QR + copia-e-cola; cartão: token do Mercado Pago), o pedido **só libera o preparo quando aprovado**; `entrega`: pedido entra como **"a receber"** com a forma escolhida (e troco), sem pagamento online. Pedido mínimo, taxa por bairro, loja fechada/pausada e estoque continuam validados como hoje.

### 5.2 Provedor do código por WhatsApp/SMS
Não existe provedor no sistema e a escolha é do cliente. Implemente **uma interface** (`services/codigoLogin.js`) com provedores plugáveis, escolhidos por variável de ambiente:
- **`simulado`** (padrão em desenvolvimento): não envia; em `NODE_ENV !== 'production'` devolve/imprime o código para os testes (e o e2e usa isso). **Em produção, `simulado` é recusado** (erro claro na inicialização/ativação).
- **`http` genérico**: envia por **HTTP** configurável (URL, método, cabeçalho de autenticação e corpo com `{telefone}` e `{mensagem}` por variáveis de ambiente), para conectar rapidamente um provedor de WhatsApp (API) ou SMS contratado sem alterar código. Mensagem padrão: "Seu código de acesso à *{loja}* é *{codigo}*. Vale por 10 minutos."
- O provedor ativo e se está **configurado** aparecem no **painel Master › Configurações globais › Integrações** (só status, sem segredos), no mesmo padrão das integrações existentes.
- Falha no envio → 502 amigável ("não foi possível enviar o código; tente de novo") sem consumir limites do usuário além do necessário; registre a falha para monitoramento (`services/monitoramento` se aplicável), **sem** gravar o código.
- Custo por mensagem é do lojista/plataforma (fora do código).

### 5.3 Formas de pagamento
- **Online**: Pix e cartão de crédito (já existem). **Débito online**: habilite **somente se** o provedor de pagamento (Mercado Pago) permitir cartão de débito pelo mesmo fluxo de token; se não for possível sem mudanças grandes, deixe `debito_online` **desligado por padrão** e implemente **débito apenas na entrega** (a loja configura). **Documente no relatório** o que o provedor suporta.
- **Na entrega/retirada**: dinheiro (campo "troco para"; valide que é ≥ total), cartão de crédito, cartão de débito, Pix — cada forma pode ser **ligada/desligada pela loja** na tela de gestão da loja virtual (hoje há `pagamentos`); a tela de gestão ganha os novos campos.
- Ao **finalizar na tela Pedidos** do sistema (venda no caixa), a forma escolhida pelo cliente vem **pré-selecionada** no pagamento (o operador pode trocar), e **pedido pago online** continua gerando a venda sem caixa como hoje.

### 5.4 Site (`loja/`) — página única
- **Rota inicial do cardápio** (`/`): componente novo (ex.: `paginas/Cardapio.jsx`), usado **apenas quando `loja.tipo === 'cardapio'`**; o varejo continua com `Inicio.jsx`. As rotas antigas do cardápio (`/produtos?categoria=…`) continuam funcionando (redirecionam para `/#categoria` ou exibem como hoje).
- **Cabeçalho** (como no preview): capa (ou gradiente da cor da loja se não houver), botões redondos de menu/entrar/buscar sobre a capa, cartão de perfil com **logo redonda**, nome, "Aberto/Fechado · fecha às …", tempo de entrega e **ações rápidas** (Sobre, Entrega, Histórico, Contato) que abrem **folhas inferiores** (bottom sheets): Sobre (horário, endereço, pagamentos, entrega), Entrega (entrega × retirada, bairro e taxa, tempo, pedido mínimo), Histórico (exige login), Contato (WhatsApp, telefone, Instagram).
- **Barra fixa (`position: sticky`)**: botão de lista de categorias (folha com a lista e contagem), botão **Filtros** (só promoções, mais pedidos, vegetarianos — se o cadastro tiver essas marcas; senão só promoções) e **chips de categorias** com rolagem horizontal. **Scroll-spy**: a categoria cujo título já passou da barra fica ativa, o chip ativo **centraliza** na barra, e no **fim da página** a **última** categoria acende; clicar rola até a seção descontando a altura da barra (`scroll-margin-top`); use `IntersectionObserver` ou o evento de rolagem com `requestAnimationFrame`, **sem travar** em listas grandes (cardápio com 200+ itens: virtualização leve não é necessária, mas evite re-render da lista inteira a cada rolagem — só o estado da categoria ativa muda). Busca no topo filtra a lista e as categorias vazias somem.
- **Cartão de produto** conforme o preview (foto à esquerda por padrão; opções de tema **foto à direita** e **grade de 2 colunas**), selo "% OFF" configurável (ligar/desligar), botão + que **adiciona direto** quando o produto não tem adicionais obrigatórios, ou abre a **folha do produto** (foto grande, descrição, grupos de adicionais com "obrigatório/opcional · até N", observação, quantidade, botão "Adicionar · R$ X"). Indisponíveis ficam esmaecidos com aviso.
- **Sacola** fixa no rodapé ("Ver sacola · N itens · R$ total") → folha com itens (remover/alterar), **entrega × retirada**, **bairro**, **pagamento** (Pagar agora online: Pix/cartão/débito; ou Pagar na entrega/retirada: dinheiro com troco/cartão crédito/cartão débito/Pix, com a explicação de cada), subtotal, taxa, total, aviso de **pedido mínimo** (botão desabilitado com quanto falta) e botão **"Pagar e finalizar"** (online) ou **"Finalizar pedido"**. Pix online mostra a tela de pagamento (QR/copia-e-cola, aguardando confirmação) e cartão online usa o formulário seguro do Mercado Pago que o site já usa (`CartaoMercadoPago.jsx`).
- **Login por telefone** (folha "Entrar"): telefone com máscara → **"Enviar código"** → campo de 6 dígitos (autoavança ao completar, **reenviar em 30 s**, "trocar telefone", erro com tentativas restantes) → se cliente novo, pede **nome** e a opção de **receber promoções por WhatsApp** (consentimento) → entra e **retoma a ação** que originou o login (finalizar ou abrir histórico). Perfil/"Conta" mostra nome, telefone e **Sair**. A conta existente de **e-mail e senha** continua funcionando no varejo.
- **Histórico/Pedidos**: lista os pedidos da conta com situação (aguardando pagamento, em preparo, a caminho, entregue, cancelado), repetir pedido (opcional se simples) e detalhe; reaproveite as páginas atuais.
- Acessibilidade: botões com `aria-label`, foco gerenciado nas folhas, `prefers-reduced-motion`; nada que dependa só de cor.

### 5.5 Gestão no sistema (admin do cliente)
Na tela de **Loja virtual** (cardápio): campo para **capa**, escolha do **estilo dos cartões** (foto à esquerda/direita/grade), liga/desliga do selo "% OFF" e da categoria "Promoções", **formas de pagamento** (online: Pix/crédito/débito; na entrega: dinheiro/crédito/débito/Pix), pedido mínimo e bairros (já existem), **pré-visualização** com o novo cardápio. A ordem das categorias e a publicação dos produtos continuam como hoje.

## 6. Testes obrigatórios (rodar e mostrar o resultado)

Crie `backend/scripts/e2e-cardapio.mjs` (padrão dos e2e; use o provedor `simulado` e o simulador do Mercado Pago) e teste no navegador (375 px e desktop):

1. `GET /cardapio` devolve as seções na ordem, **"Promoções" automática** com `% off` correto (arredondado), produtos indisponíveis marcados e **nada de outra empresa/loja**; resposta com cache coerente.
2. **Scroll-spy** (navegador): ao rolar, o chip ativo muda para a categoria correta, a barra rola o chip para o centro, clicar num chip leva à seção certa (descontando a barra fixa) e no fim da página a última categoria fica ativa; **sem travamentos** (meça com ~200 itens).
3. **Login por telefone**: pedir código → entrar com o código certo (cliente novo exige nome e cria conta + cliente em Clientes; cliente existente entra direto); código errado ×3 invalida; código **expirado** e **reutilizado** falham; **limites** de pedido de código por telefone/IP; resposta de `/conta/codigo` **idêntica** para telefone existente e novo; código **nunca** aparece em logs/respostas em produção (`NODE_ENV=production` com provedor `simulado` é recusado).
4. **Navegar/montar sacola sem conta** funciona; **finalizar** e **histórico** pedem login e **retomam a ação** depois.
5. **Pagamento online**: Pix (QR + copia-e-cola, pedido só libera o preparo ao aprovar), cartão de crédito aprovado/recusado (simulador); **débito online** conforme o provedor (ou desligado e documentado). Pedido aprovado vira venda sem caixa como hoje; estorno/cancelamento seguem funcionando.
6. **Pagamento na entrega/retirada**: dinheiro com troco (validação `troco_para ≥ total`), cartão crédito, cartão débito e Pix; a tela **Pedidos** mostra "a receber" com a forma e o troco, e no fechamento a forma vem **pré-selecionada**; formas desligadas pela loja são recusadas (400).
7. **Entrega × retirada**: taxa por bairro somada ao total; retirada sem taxa; **pedido mínimo** respeitado (servidor); loja **fechada/pausada** bloqueia finalizar; produto sem estoque não adiciona.
8. **Adicionais**: grupos obrigatórios/máximos validados **no servidor** (um pedido adulterado é recusado); preço dos adicionais somado e gravado; baixa de insumos/estoque correta como no PDV.
9. **Isolamento e compatibilidade**: loja de **varejo** continua exatamente como antes (home por blocos, conta por e-mail e senha, frete, grades); contas antigas entram por código se quiserem; outra empresa não vê dados.
10. **Regressão**: `e2e-loja-virtual` (com simuladores), `e2e-estoque-vendas`, `e2e-financeiro`, `e2e-relatorios`, pedidos/garçom/clientes e `e2e-modulos` — compare com a execução anterior; temas claro e escuro; Lighthouse/peso do site (imagens com lazy-load, bundle do cardápio sem inflar o varejo).

## 7. Fora do escopo

Mesa/QR de mesa/chamar garçom, agendamento de pedido, tabela de preço por cliente, programa de fidelidade/cashback, rastreio em mapa do entregador, avaliações dos clientes, múltiplas lojas por empresa no site, integração com maquininha, app instalável nativo (PWA do site é opcional futuro).

## 8. Ordem sugerida de commits

1. Migrations (capa, contas por telefone, códigos de login, pagamentos/troco). 2. Serviço de código de login (interface, `simulado`, `http`) + status no painel Master. 3. Endpoints `/conta/codigo` e `/conta/entrar` com limites e testes. 4. `GET /cardapio`, adicionais em `/produtos/:id` e validação no pedido. 5. Pedido com `pagamento{quando,forma,troco}` e integração com a tela Pedidos/fechamento. 6. Site: página única, barra fixa e scroll-spy. 7. Site: cartões, folha do produto e sacola. 8. Site: login por telefone, pagamento e histórico. 9. Gestão: capa, estilos e formas de pagamento. 10. e2e novo e regressão.

## 9. Entrega

Rode os testes da seção 6 e faça um **relatório em português**: o que foi feito por commit, decisões e **desvios do desenho** (com o motivo), o que o **provedor de pagamento permite** (débito online), como configurar o **provedor do código** (variáveis de ambiente, sem repetir segredos), resultados (inclusive falhas e o que já falhava antes), pendências e qualquer funcionalidade existente que você **não removeu** mas notou conflito. Inclua capturas de tela do cardápio em 375 px (claro e escuro).

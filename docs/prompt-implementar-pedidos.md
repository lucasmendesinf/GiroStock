# Prompt — Implementar "Pedidos" + "Clientes" (lanchonete): PDV gera pedido, quadro de pedidos, reserva de estoque e base de clientes

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Os modelos visuais **já foram validados** pelo cliente: `docs/pedidos-preview/preview-pedidos.html` (PDV + Pedidos) e `docs/clientes-preview/preview-clientes.html` (Clientes).

---

## 1. Objetivo

Na loja **Lanchonete** a venda não é imediata como na distribuidora: o cliente pede (balcão, telefone, WhatsApp), o lanche é **preparado**, e só depois é **retirado ou entregue**. Criar:

1. **Aba/tela "Pedidos"** (quadro por status + lista) para acompanhar cada pedido até ser entregue.
2. **PDV com seletor Venda | Pedido**: o PDV continua igual ao de hoje; a única novidade é poder **gerar um pedido** em vez de finalizar a venda.
3. **Reserva de estoque ao criar o pedido** (e devolução ao cancelar), para um pedido novo não consumir o que já está prometido a outro.
4. **Módulo Clientes**: base de clientes criada a partir dos pedidos (telefone = chave), usada no PDV para **preencher os dados do cliente ao digitar o telefone**, com segmentos e preparação para envio de mensagens.
5. **Origem do pedido** escolhida no PDV (Balcão, Telefone, WhatsApp). iFood e 99Food ficam **para uma etapa posterior** — deixar o modelo de dados pronto para eles, sem implementar a integração.

**O visual e o comportamento devem ficar iguais aos previews.**

## 2. Fonte da verdade visual (leia primeiro)

Arquivos (HTML único, CSS e JS embutidos): `docs/pedidos-preview/preview-pedidos.html` e `docs/clientes-preview/preview-clientes.html`. Sirva os dois (portas 8097 e 8096) e clique em tudo; ambos são especificação exata de textos, estados e regras.

1. Sirva e abra em uma **aba normal do navegador**:
   ```bash
   cd docs/pedidos-preview
   npx --yes serve -l 8097 .      # ou: python -m http.server 8097
   cd ../clientes-preview && npx --yes serve -l 8096 .
   ```
   Abra `http://localhost:8097/preview-pedidos.html` e `http://localhost:8096/preview-clientes.html`.
2. Clique em **tudo**: botões de avançar status nos cards, clique no card (gaveta de detalhe), filtros por origem, busca, Quadro/Lista, "+ Novo pedido", menu **PDV** (modo Venda/Pedido, origem, F2, setas, `3*`, Esc), botão de tema claro/escuro.
3. Leia o código: ele é a especificação de **textos, estados, cores, mensagens e regras** (ex.: "Sem estoque disponível de X", "🔒 Reservado", "reserva convertida em baixa definitiva").
4. **Dados do preview são fictícios.** No sistema use a API real. Copie fielmente estrutura/classes/textos, adaptando para React e para as variáveis CSS atuais de `frontend/src/styles.css` (paleta "dourado contido": `--bg`, `--panel`, `--panel-alt`, `--gold`/`--gold-light`, `--accent-soft`, `--ok`, `--warn`, `--err`, `--muted`, `--line`; tema claro e escuro precisam continuar funcionando). **Não reintroduza** gradientes vinho→dourado nem títulos dourados: siga a paleta já aplicada.

## 3. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, **não remova**: mantenha e liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador (`npm run dev` em `frontend` e `backend`) antes de dizer que terminou; build não basta.
- Após qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Não quebre o PDV atual** (venda direta, F2, atalhos, comanda/senha do cliente, observação por item, impressão de cupom e comanda da cozinha, caixa). Teste a venda direta de ponta a ponta depois de cada mudança no PDV.

## 4. Estado atual do sistema (para se localizar)

- `backend/src/routes/sales.routes.js`: `POST /sales` já faz tudo em uma transação: valida estoque, grava `sales` + `sale_items` (com `observacao`), **baixa estoque** (`stock_balances` + `stock_movements`) ou **consome insumos pela ficha técnica** (`ingredient_balances` + `ingredient_consumptions`), gera **`numero_pedido` (comanda) por loja** quando `locations.usa_comanda`, grava auditoria. `POST /sales/:id/cancel` estorna estoque e insumos.
- Já existem: comanda da cozinha impressa por via, senha do cliente (retirada), observação do item em produtos com receita, caixa aberto por PDV, permissões por área (`requireArea('Vendas')`, `areasEfetivas`).
- `frontend/src/pages/PDV.jsx`: PDV tela cheia (busca, tabela de resultados "dá para N un.", carrinho, F2 pagamento). Migrations em `backend/src/db/migrations` (última: `012_observacao_item.sql`; criar a `013_...`).
- Moeda: valores `NUMERIC` no banco. Se a máscara BRL/centavos já estiver no projeto, use-a; senão não introduza agora.
- Estoque disponível = saldo − reservado, **por loja**. Para produto com ficha técnica a reserva é dos **insumos** (quantidade_por_unidade × quantidade), por loja.

## 5. Modelo de dados (migration `013_pedidos_clientes.sql`)

Crie (sempre com `tenant_id`, índices por tenant/loja/status):

- `orders`: `id`, `tenant_id`, `location_id`, `numero` (sequencial por loja, exibido como `#1042`; pode reaproveitar o contador de `numero_pedido`/comanda **se** `usa_comanda`, senão criar contador próprio por loja), `origem` (`balcao|telefone|whatsapp|ifood|99food`, CHECK), `origem_externa_id` (nulo por enquanto; para iFood/99Food), `cliente_nome`, `cliente_telefone`, `tipo` (`retirada|entrega`), `endereco`, `taxa_entrega NUMERIC(12,2) DEFAULT 0`, `observacao`, `forma_pagamento_prevista` (dinheiro|cartao|pix…), `pago BOOLEAN DEFAULT false`, `status` (`novo|em_preparo|pronto|saiu_entrega|finalizado|cancelado`), `entregador_id` (nulo), `sale_id` (nulo; preenchido ao finalizar), `criado_por`, `criado_em`, `atualizado_em`, `finalizado_em`, `cancelado_em`, `motivo_cancelamento`.
- `order_items`: `id`, `order_id`, `product_id`, `quantidade`, `preco_unitario`, `subtotal`, `observacao`.
- `order_status_log`: `order_id`, `de`, `para`, `usuario_id`, `criado_em` (alimenta a linha do tempo "Andamento" da gaveta e o tempo por etapa).
- `couriers` (entregadores): `id`, `tenant_id`, `nome`, `ativo`. CRUD mínimo (pode ficar em Configurações/Usuários; no preview são só 3 nomes de exemplo).

- `customers` (clientes): `id`, `tenant_id`, `nome`, `telefone` (só dígitos; **UNIQUE (tenant_id, telefone)** quando não nulo), `aniversario` (dd/mm, opcional), `observacao`, `aceita_mensagens BOOLEAN DEFAULT false`, `consentimento_em`, `consentimento_origem`, `criado_em`, `ativo`. `customer_addresses`: `id`, `customer_id`, `rotulo` (Casa/Trabalho…), `endereco`, `bairro`, `padrao`. Em `orders`: `customer_id` (nulo). Opcional: `message_log` (cliente, modelo, texto, enviado_por, criado_em) para o histórico de envios.

**Reserva**: não mexa em `stock_balances`/`ingredient_balances` ao criar o pedido. Calcule o reservado por consulta sobre pedidos **em aberto** (`status NOT IN ('finalizado','cancelado')`): produto simples → soma de `order_items.quantidade`; produto com ficha → soma de `quantidade_por_unidade × quantidade` por insumo. `disponivel = saldo − reservado`. Exponha isso numa função/serviço único reutilizado por PDV, busca de produtos e criação/edição de pedido (e ao mesmo tempo previna corrida: faça o check de disponibilidade **dentro da transação**, com `SELECT … FOR UPDATE` nos saldos envolvidos).

## 6. Back-end (`backend/src/routes/orders.routes.js`, registrar em `app`)

Todas as rotas exigem autenticação e permissão de área (use `requireArea('Vendas')` ou crie a área `Pedidos` seguindo o padrão de permissões por usuário existente; admin vê tudo). Respeitar loja do usuário (`req.user` / lojas extras).

- `POST /orders` — cria pedido (`status='novo'`) **na mesma transação**: valida itens, valida **disponível ≥ quantidade** (erro 409 com a mensagem `Sem estoque disponível de <produto>`), grava `orders`/`order_items`/log, auditoria. Não baixa estoque.
- `GET /orders?location_id&status&origem&q&de&ate` — lista (para quadro e lista). `GET /orders/:id` — detalhe (itens, log, pagamento, entregador).
- `POST /orders/:id/status` `{ para, entregador_id? }` — avança conforme o fluxo e **rejeita transições inválidas**:
  `novo → em_preparo → pronto → (entrega: saiu_entrega → finalizado | retirada: finalizado)`; `cancelado` a partir de qualquer estado exceto `finalizado`. Entrega exige `entregador_id` ao ir para `saiu_entrega`.
- **Finalizar** (`→ finalizado`): numa transação, **converte a reserva em baixa definitiva** criando a **venda** correspondente (reaproveite a lógica de `POST /sales` extraindo-a para um serviço compartilhado; não duplique código): grava `sales`/`sale_items`, baixa estoque/consome insumos, registra no **caixa** com a forma de pagamento (se `pago=false`, receber o pagamento nesse momento: pedir forma de pagamento/valor recebido/troco como o F2 do PDV faz), liga `orders.sale_id`. Dinheiro só entra no caixa aqui.
- `POST /orders/:id/cancel` `{ motivo }` — `status='cancelado'`; como a reserva é calculada, ela é **liberada automaticamente**. Se já finalizado → 409 (cancelamento é pela venda, `POST /sales/:id/cancel`, que já estorna).
- `PATCH /orders/:id` — editar itens/observação/endereço enquanto `novo|em_preparo` (revalidar disponibilidade). Se não der tempo, deixe fora e liste como pendência.
- `GET /products/search` (o que o PDV usa) e a lista do PDV: devolver também `disponivel` (saldo − reservado) e `controlado_por_insumos` (tem ficha técnica). O "dá para N un." do PDV passa a usar o **disponível**.
- Impressão: ao criar o pedido, imprimir/gerar a **comanda da cozinha** com o mesmo formato já existente (nº do pedido, itens, observações, origem, retirada/entrega). Reutilize o código de comanda atual.

Testes manuais obrigatórios: criar 2 pedidos que juntos excedem o estoque (o 2º deve falhar), cancelar o 1º (o 2º volta a ser possível), finalizar (estoque e insumos baixam uma única vez; caixa recebe), cancelar venda finalizada (estorno já existente).

## 6-B. Back-end de Clientes (`backend/src/routes/customers.routes.js`)

Permissão de área própria **`Clientes`** (padrão de permissões por usuário já existente). Todas as rotas filtram por `tenant_id`.

- `GET /customers?q&segmento&location_id` — lista com agregados calculados dos pedidos/vendas finalizados: `pedidos`, `total_gasto`, `ticket_medio`, `ultimo_pedido_em`, `produto_favorito`, `segmentos[]`. Segmentos calculados no servidor: **novo** (primeiro pedido ≤ 30 dias), **recorrente** (≥ 3 pedidos), **vip** (total ≥ limite configurável, padrão R$ 400), **risco** (30–59 dias sem pedir), **inativo** (≥ 60 dias), **aniversario** (mês corrente), **sem_whatsapp** (sem telefone).
- `GET /customers/by-phone/:telefone` — busca exata (só dígitos) e `GET /customers/suggest?telefone=` (trecho de 4–9 dígitos, máx. 3); usado pelo PDV. Resposta inclui endereços e agregados curtos (nº de pedidos, último pedido).
- `POST /customers`, `PATCH /customers/:id`, `POST /customers/:id/addresses`, `DELETE` (desativar). Telefone duplicado → 409 com mensagem "Já existe cliente com este telefone".
- `GET /customers/import-preview` e `POST /customers/import` — **"Gerar a partir dos pedidos"**: lê nome/telefone/endereço dos pedidos e vendas já existentes **que ainda não têm cliente**, agrupa por telefone normalizado, marca **novo**, **mesclar** (mesmo telefone, grafia de nome diferente) ou **ignorado** (sem telefone, ex.: balcão); cria só os selecionados, vincula os pedidos antigos (`customer_id`) e entra com `aceita_mensagens=false`.
- `POST /customers/:id/merge` `{ para_id }` — mescla duplicados (move pedidos e endereços; mantém o cadastro de destino).
- `GET /customers/:id` — ficha: dados, endereços, últimos pedidos, produto favorito, histórico de mensagens.
- Mensagens (fase 2, **sem API oficial por enquanto**): `POST /customers/campaigns/preview` `{ segmento, modelo, texto }` → devolve destinatários (**somente `aceita_mensagens=true` e com telefone**) e o texto com `{nome}` substituído; o front gera, para cada um, o link `https://wa.me/55<telefone>?text=<mensagem>` (abre o WhatsApp do atendente) e `POST /customers/campaigns/queue` registra a fila/histórico. Toda mensagem de campanha deve incluir "responda SAIR para não receber mais".
- Respeite LGPD: só enviar a quem consentiu, registrar data/origem do consentimento.

## 7. Front-end

### 7.1 PDV (`pages/PDV.jsx`) — alteração mínima

Igual ao preview (tela "PDV — Lanchonete" do mock), **sem mudar o resto do PDV**:

- Acima do TOTAL do carrinho, seletor **Venda | Pedido** (padrão **Venda**).
- **Regra de ouro:** se o carrinho tiver **qualquer produto controlado por insumos (ficha técnica)**, o seletor **some** e o carrinho vira **pedido automaticamente** (aviso: "Produto com preparo (insumos). Este carrinho só pode virar pedido: a cozinha recebe, o estoque dos insumos é reservado."). Carrinho misto (lanche + refrigerante) também vira pedido inteiro. Se o carrinho esvaziar, volta para Venda.
- Em modo **Pedido** aparece **Origem do pedido**: Balcão · Telefone · WhatsApp (padrão Balcão) e o botão passa a **"Gerar pedido F2"**. A coluna "Estoque" da busca mostra o disponível (saldo − reservado).
- F2 em modo Pedido abre modal **"Gerar pedido"**: nome, telefone, **Retirada/Entrega** (entrega: endereço + taxa de entrega), forma de pagamento (pagar na retirada/entrega em dinheiro/cartão, ou "Pix (já pago)"), lista de itens (+ observação do carrinho) e total com taxa. Confirmar → `POST /orders`, limpa o carrinho, toast "Pedido #N gerado · estoque reservado" e (por padrão) permanece no PDV pronto para o próximo (no preview vai para Pedidos; **deixe o PDV permanecer**, é mais ágil para quem está no balcão — avise no relatório final).
- Modo **Venda** não muda nada: finalizar, pagamento, baixa imediata.

### 7.1-B Cliente no PDV e pedido rápido (regras validadas no preview)

- **Campo "Cliente (opcional) — digite o telefone"** no carrinho do PDV, logo abaixo da observação. **Só aparece quando o carrinho tem produto com insumos (ficha técnica)**. Venda de produto comum (refrigerante, etc.) **não mostra** o campo. Se o produto com insumos sair do carrinho, o campo some e o telefone digitado é descartado.
- A chave do cliente é o **telefone (só dígitos)**, único por empresa (`tenant`). Busca ao digitar:
  - 10+ dígitos com cadastro existente → cartão verde "✔ Cliente cadastrado" com nome, telefone, endereços, nº de pedidos e "último há X dias"; ao gerar o pedido o **nome e o endereço (se Entrega) já vêm preenchidos**, com botões para escolher entre os endereços salvos; o pedido é **vinculado** (`orders.customer_id`);
  - 4–9 dígitos → sugere até 3 clientes cujo telefone contém o trecho (clique preenche);
  - 10+ dígitos sem cadastro → "Cliente novo": será criado ao gerar o pedido (checkbox **"Cadastrar este cliente"** marcado no modal), com consentimento "não aceita mensagens" até alguém confirmar;
  - vazio → pedido sem cadastro.
- **Pedido rápido (origem Balcão):** em modo Pedido com origem Balcão, o botão vira **"Gerar pedido rápido F2"** e **não abre modal**: cria o pedido na hora (retirada, `pago=false`, "pagar no balcão ao retirar"), reserva o estoque e mostra/imprime a **comanda** (nº do pedido bem grande, itens, observação, total). Campo opcional "Nome para chamar". Se um telefone cadastrado foi digitado, o pedido sai no nome do cliente; senão, sem cadastro. O PDV permanece pronto para o próximo.
- **Telefone/WhatsApp:** F2 abre o modal "Gerar pedido" já com telefone e nome preenchidos (se o cliente existe).
- Ao criar/vincular, atualizar o cliente (pedidos, último pedido) — de preferência **calculado por consulta**, sem contadores duplicados.
- **Venda direta** de produto simples continua sem cliente.

### 7.2 Tela "Pedidos" (nova)

Novo item no menu (**Pedidos**, antes de Produtos & Estoque), só visível para quem tem a permissão e para lojas que usam pedidos. Sugestão: flag `locations.usa_pedidos` (a Distribuidora fica sem a aba). Conteúdo **igual ao preview**:

- Cabeçalho: título "Pedidos", seletor de loja, botão **+ Novo pedido** (abre o mesmo modal, com busca de produto, quantidades e checagem de disponível).
- 5 KPIs: Novos (destaque, pulsa se > 0), Em preparo, Prontos, Em entrega, Finalizados hoje (+ selo "N atrasado(s)").
- Chips de origem (Todas, Balcão, Telefone, WhatsApp; **iFood e 99Food só aparecem quando existir integração** — deixe o filtro preparado, oculto por enquanto), busca (nº, cliente, telefone), alternância **Quadro | Lista**.
- **Quadro** com 5 colunas (Novo, Em preparo, Pronto, Saiu p/ entrega, Finalizado). Card: `#nº`, tag de origem, tempo em minutos (faixa/valor laranja se > 25 min parado em Novo/Em preparo), cliente, itens resumidos, tag Retirada/Entrega, pill Pago/Receber, "🔒 Reservado" enquanto aberto, total e **botão de avançar** ("Iniciar preparo", "Marcar pronto", "Saiu p/ entrega" ou "Entregue ao cliente" para retirada). Finalizados do dia ficam na última coluna; dias anteriores só na Lista.
- **Gaveta de detalhe** (clique no card): cliente/telefone/endereço, observação, linha do tempo "Andamento" (de `order_status_log`), escolha de **entregador** ao ficar pronto/saiu, itens + taxa + total, pagamento, "Estoque: Reservado até finalizar / Baixa definitiva", botões Imprimir (comanda) e Cancelar (pede motivo).
- Atualização automática: `setInterval` de polling (ex.: 15 s) na lista; deixe um ponto de extensão para WebSocket/SSE no futuro (iFood/99Food). Som/destaque opcional para pedido novo.
- Dinheiro e datas em pt-BR; textos exatamente como no preview.

### 7.3 Tela "Clientes" (nova)

Item de menu **Clientes** (permissão de área `Clientes`), **igual ao preview `preview-clientes.html`**: título, seletor de loja (Todas/Lanchonete/Distribuidora), botões **"Gerar a partir dos pedidos"**, **"Enviar mensagem"**, **"+ Novo cliente"**; faixa "💡 Encontramos N clientes novos e M possíveis duplicados nos seus pedidos" com **Revisar e criar**; 5 KPIs (Clientes · Novos 30 dias · Ativos 30 dias · **Para reativar** em destaque, clicável · Ticket médio); chips de segmentos com contagem; busca; tabela (Cliente/telefone, Bairro, Pedidos, Total gasto, Ticket médio, Último pedido colorido por antiguidade, Segmentos, Mensagens Aceita/Não aceita/Sem contato); **gaveta de detalhe** (estatísticas, produto favorito, aniversário, endereços, últimos pedidos, switch de consentimento com data/origem, observações, botões Novo pedido / Repetir último pedido / ✉ Mensagem); modais "Gerar clientes a partir dos pedidos" (checkboxes, pills Novo cliente / Mesclar com X / Já cadastrado / Sem telefone — ignorado), "Enviar mensagem" (segmento, modelo, texto com {nome}, prévia, destinatários só com consentimento, "Abrir no WhatsApp", "Criar fila de envio") e "Novo cliente" (nome, telefone, endereço, bairro, aniversário, consentimento). Os blocos "Ideias para evoluir" e "Pontos para decidir" do preview são **só documentação**: não coloque na tela.

Os modelos de mensagem (Reativação, Aniversário, Promoção do dia, Pedido pronto) usam os textos do preview; deixe-os em tabela/constante editável pelo admin se for simples, senão constantes no código.

"Repetir último pedido" monta o carrinho do PDV com os itens do último pedido do cliente (respeitando disponibilidade) e já deixa o telefone preenchido.

## 8. Itens fora do escopo (não implementar agora)

- Envio automático em lote pela API oficial do WhatsApp, cupons/fidelidade e relatório de retorno de campanhas (só ideias no preview).
- Integração iFood/99Food (apenas deixar `origem`/`origem_externa_id` no modelo; o fluxo "Aceitar/Recusar" do preview é só referência futura).
- Impressão térmica nova, relatórios de pedidos, edição completa de pedido em preparo (se `PATCH` ficar para depois, registre).

## 9. Ordem sugerida de commits

1. Migration `013` + serviço de reserva/disponibilidade. 2. Rotas de Clientes (busca por telefone, CRUD, importação). 3. Rotas de Pedidos + finalização via serviço de venda. 4. PDV (Venda | Pedido, campo de cliente, pedido rápido, comanda). 5. Tela Pedidos. 6. Tela Clientes + mensagens. 7. Ajustes de tema/permissões.

## 10. Entrega

Ao final, rode o fluxo completo no navegador (PDV → gerar pedido → avançar até finalizado; cancelar; reserva barrando o segundo pedido; venda direta de produto simples sem campo de cliente; lanche com telefone de cliente cadastrado preenchendo nome/endereço; telefone novo criando cliente; pedido rápido de balcão gerando a comanda; Clientes: gerar a partir dos pedidos, mesclar, segmentos, consentimento, fila de mensagens; tema claro e escuro) e faça um **relatório em português** com: o que foi feito por commit, decisões tomadas (ex.: PDV permanece na tela após gerar pedido), pendências e qualquer funcionalidade existente que você **não removeu** mas notou conflito.

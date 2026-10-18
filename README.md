# GiroStock — Etapa 2 (Estrutura Principal + PDV)

Sistema de gestão da JA Conveniência (Calutec Soluções). Esta etapa implementa cadastros de base, estoque multi-local, ficha técnica de insumos, PDV e controle de caixa.

## Stack

- Frontend: React + Vite (PWA)
- Backend: Node.js + Express (API REST)
- Banco: PostgreSQL
- Cache/filas: Redis
- Proxy: Nginx
- Containers: Docker + Docker Compose

## Subindo o ambiente

```bash
cd backend
cp .env.example .env

cd ..
docker compose up -d --build
docker compose exec api npm run migrate
docker compose exec api npm run seed
```

Acesse:

- App completo via Nginx: http://localhost:8080
- API direta: http://localhost:3000
- Frontend (dev, sem Docker): `cd frontend && npm install && npm run dev`

## Uso no dia a dia

### PDV (feito para o teclado e o leitor de código de barras)

| Tecla / entrada | O que faz |
|---|---|
| Código de barras + `Enter` | adiciona o produto (o leitor já envia o Enter) |
| `3*7891234567890` | adiciona 3 unidades |
| `0,350*7891234567890` | produto por peso/volume (KG, L): 0,350 kg |
| Digitar o nome, `↑` `↓`, `Enter` | busca por nome e escolhe o resultado |
| `Del` (com a busca vazia) | tira o último item |
| `F2` | abre o pagamento |
| `1` `2` `3` `4` (no pagamento) | Pix, crédito, débito, dinheiro |
| `Enter` (no pagamento) | confirma a venda |
| `P` / `F9` | imprime o cupom (não fiscal) da venda / reimprime o último |
| `F4` | sangria / suprimento |
| `F6` | cancela a venda em andamento |
| `F8` | fecha o caixa |

- A busca mostra também produtos sem saldo na loja do PDV, esmaecidos e marcados "sem estoque nesta loja" (com aviso se há em outra loja); eles não podem ser vendidos, e a quantidade no carrinho é limitada ao saldo.
- A quantidade pode ser digitada no carrinho (produtos em KG/L abrem o campo de peso ao serem adicionados).
- Desconto em R$ ou %, botão "valor exato" e troco calculado na hora.
- Cada venda recebe um número curto e sequencial por empresa (Venda nº 123).
- No PDV o menu do sistema fica escondido (modo caixa) para o operador não sair da venda sem querer.

### PDV no celular / tablet (garçom na mesa)

Em aparelho de toque o PDV se adapta sozinho:

- A **lista de produtos fica aberta** (com filtro por categoria); tocar no produto adiciona e mostra quantos já estão no pedido. O teclado do celular só abre quando se toca na busca.
- Lanche com adicionais abre a escolha dos complementos; a lista continua aberta para o próximo item.
- **Barra fixa embaixo** com a quantidade e o total; *Ver pedido* leva ao carrinho (destino **Mesa**, número da mesa, *Gerar pedido*).
- A comanda mostra **MESA 5** em destaque e "A pagar na mesa".
- Sem as dicas de teclas (F2, F4…), botões maiores para o dedo, campos com 16px (o iPhone não dá zoom ao tocar), avisos no topo da tela.
- **Busca no celular**: ao tocar na busca ela sobe para o topo (a lista cabe acima do teclado), fica presa no topo ao rolar a lista, tem um **×** para limpar e voltar à lista completa, e o navegador não mostra sugestões de senha/cartão/endereço por cima. A página não dá zoom sozinha.
- **Pagamento**: botões grandes; Voltar/Confirmar sempre visíveis no rodapé da janela; escolher Dinheiro não abre o teclado sozinho (os valores rápidos de troco resolvem a maioria dos casos).
- Testado de 320px (celular pequeno) a tablet, em pé e deitado, e no tamanho do iPhone SE (375×667) com o teclado aberto.

### Telas

- O menu mostra só as telas que o perfil pode usar; quem abre uma tela sem permissão vê um aviso.
- Cada perfil cai na sua tela inicial: Caixa no PDV, os demais no **Início** (vendas de hoje, alertas de estoque, caixas abertos).
- **Produtos**: cadastro e estoque são separados. A lista tem busca (nome, código PRD ou EAN), filtros por loja, categoria, fornecedor, situação e chips (todos, estoque baixo, sem estoque, controlados por insumos), com linha verde/amarela/vermelha pela situação do estoque. No fim de cada linha ficam dois ícones: **lápis** (editar o produto) e **caixa** (tratar o estoque).
  - O cadastro/edição só trata os dados do produto (sem estoque inicial). Produto novo aparece "sem estoque" até a primeira entrada.
  - O modal de estoque (ícone de caixa) tem as abas Saldo por loja (com mínimo editável), Entrada, Transferência, Saída, Balanço e Histórico. O **balanço** (`POST /api/products/:id/stock-adjustment`) substitui o saldo da loja pela contagem e guarda a diferença no histórico (migração `007_balanco_produto.sql`).
  - Produto **controlado por insumos** (lanche/receita) não tem estoque próprio: o lápis e a caixa abrem a edição já na receita (quantidade por unidade editável, "dá para N", custo = soma dos insumos).
- **Entrada por nota**: vários produtos de uma compra lançados de uma vez (aceita leitor), com fornecedor e número da nota.
- **Insumos**: um botão "Movimentar" por insumo (entrada, saída, transferência, balanço e mínimo), já na loja que tem saldo.
- **Relatórios**: período (hoje, ontem, 7 dias, mês, mês passado ou datas), ranking de produtos, descontos, histórico paginado e fechamentos de caixa (esperado × contado).
- **Usuários**: perfil padrão Caixa, confirmação ao mudar acesso, edição de nome e redefinição de senha; cada usuário troca a própria senha no menu da conta.
- Valores e quantidades no padrão brasileiro (R$ 1.234,56), avisos no canto da tela e confirmação em ações que desativam ou cancelam algo.
- Funciona em celular e tablet (menu recolhível e tabelas que escondem colunas secundárias).

### Migração `005_ux_vendas_numero_desconto.sql`

- Numera as vendas existentes por empresa, na ordem em que foram feitas, e cria os campos de subtotal e desconto.

## Módulos por plano e por empresa (painel Master)

Cada cliente usa só os módulos (segmentos) que contratou. O Master define isso no **plano** (Configurações → Planos) e pode ajustar empresa por empresa (Empresas → ficha → Módulos liberados), inclusive já na criação da empresa.

| Módulo | O que libera | Precisa de |
|---|---|---|
| Ponto de venda (PDV) | caixa, venda no balcão, sangria/suprimento, desconto, cancelamento | — |
| Lanchonete e cozinha | ficha técnica, insumos com baixa automática, comanda da cozinha | PDV |
| Pedidos | mesa, retirada, entrega, WhatsApp, entregadores | PDV |
| Clientes | base de clientes, segmentos e mensagens | — |
| iFood e 99Food | pedidos das plataformas na tela de Pedidos | Pedidos |
| Casa de shows e eventos *(em breve)* | eventos, PDVs e estoque do evento | PDV |
| Loja virtual | site da loja ligado por API, produtos com fotos, cupons, entrega por bairro, Pix/cartão (Mercado Pago), pedidos com separação, envio e rastreio | — (cardápio digital usa a tela de Pedidos) |
| Financeiro | contas a pagar/receber, fluxo de caixa, resultado do mês | Financeiro |

- Sempre incluído em qualquer plano: Início, Produtos & Estoque, Fornecedores, Lojas & PDVs, Usuários e Relatórios.
- Planos prontos: **Só PDV** (varejo/distribuidora), **Lanchonete**, **Básico** e **Completo**. O Master cria novos planos e remove os que nenhuma empresa usa (o Completo é o padrão e não pode ser removido).
- Ligar um módulo liga junto o que ele precisa; desligar desliga junto o que depende dele. O servidor recusa combinações inválidas.
- Módulo desligado vale **na hora** para todos os usuários da empresa, inclusive o Administrador: some do menu e das telas, e a API responde 403 ("não faz parte do plano"). As permissões desses módulos também somem da tela de usuários.
- Módulos "em breve" já podem ser liberados: passam a valer quando ficarem prontos.
- Catálogo em `backend/src/config/modulos.js`. A migração `024_modulos_por_plano.sql` não muda nada para quem já usa: os planos existentes mantêm PDV e Lanchonete, Pedidos/Clientes seguem como estavam.

## Combos e complementos (adicionais)

- **Complementos** (Produtos & Estoque → aba *Complementos*): grupos com mínimo e máximo — ex.: *Adicionais* (0 a 3: Bacon extra +R$ 3, Cheddar +R$ 2) e *Escolha a bebida* (obrigatório 1). Cada opção tem preço e pode **baixar um insumo** (Bacon extra = 30 g de bacon, exige o módulo Lanchonete), **baixar um produto** (Refri lata) ou não baixar nada (ex.: "ao ponto").
- No cadastro do produto, marque quais grupos ele oferece. No **PDV** e no **novo pedido**, ao adicionar o produto abre a escolha; o preço soma no item, a regra de mínimo/máximo é conferida e os complementos saem no cupom e na comanda da cozinha.
- **Combo**: produto feito de outros produtos (X-Burguer + Batata + Refri), sem estoque próprio. A venda baixa cada componente (estoque da revenda, insumos dos lanches). O custo é a soma dos componentes. Para o cliente escolher a bebida, use um grupo obrigatório com as bebidas como opções que baixam produto.
- Toda baixa (venda, reserva de pedido, disponibilidade no PDV e no iFood) usa a mesma regra: `backend/src/services/consumo.js`. Cancelar a venda estorna tudo, inclusive componentes do combo e insumos dos adicionais.
- Complemento já usado em venda/pedido não é excluído (só desativado). Combo dentro de combo não existe.

## iFood (módulo "iFood e 99Food")

Os pedidos do iFood entram sozinhos na tela **Pedidos**, reservam o estoque e ficam sincronizados com o iFood.

- **Conectar a loja** (Lojas & PDVs → "Receber pedidos do iFood" → *Conectar iFood*). O GiroStock gera um **código de vínculo**; a loja abre o Portal do Parceiro iFood, informa o código, autoriza o app e cola de volta o **código de autorização**. Conta com várias lojas no iFood: escolhe-se qual é esta.
- **Recebimento**: o servidor consulta o iFood a cada 30 s. O evento só é confirmado (ACK) depois de gravado; se algo falhar, o iFood entrega de novo.
- **Itens**: o item do iFood vira o produto cujo **código interno** (ex.: PRD-0002) ou **código de barras** é igual ao *código PDV* do item no cardápio do iFood. Item sem correspondência deixa o pedido em "aguardando vínculo": a equipe escolhe o produto uma vez e o vínculo fica guardado. Complementos entram no preço e na observação do item.
- **Valores**: preço do iFood (com complementos), desconto bancado pela loja e taxa de entrega só quando a loja entrega. Pago online vira a forma **"Pago online (iFood)"**, que não entra no dinheiro do caixa; cobrado na entrega usa dinheiro (com troco)/cartão/Pix.
- **Status**: *Aceitar no iFood* (ou aceite automático, que não aceita pedido com falta de estoque) → *Iniciar preparo* → *Marcar pronto* → entrega da loja: *Saiu p/ entrega* (despacho no iFood) / entrega do iFood: *Retirado pelo iFood*. Finalizar gera a venda.
- **Cancelamento**: pela loja, com um motivo da lista do iFood (o pedido daqui cancela quando o iFood confirmar); cancelamento do cliente/iFood cancela aqui sozinho; pedido de cancelamento do cliente depois de aceito aparece para *Aceitar* ou *Recusar*.
- **Adicionais do iFood**: complemento do pedido do iFood cujo *código PDV* é igual ao código de um complemento do GiroStock (ex.: `ADC-BACON`) baixa o insumo/produto dele; sem código, fica só na observação.
- **Código do produto no iFood**: por padrão o código interno (PRD-0002); dá para usar outro no cadastro do produto (*Código PDV no iFood*).
- **Disponibilidade automática**: produtos marcados **"Vender no iFood"** e complementos com código são pausados no iFood quando acaba o estoque (ou um insumo da receita) na loja conectada e reativados quando volta — a cada ciclo (30 s), só as mudanças. Em Lojas & PDVs → *Cardápio no iFood* aparece o que está à venda/pausado e o motivo. *(Caminho e formato da chamada de pausa a confirmar na homologação: `api.js`, `disponibilidade`.)*
- **Falta de estoque**: o pedido entra assim mesmo (ele já existe no iFood), marcado "Falta estoque", e não é aceito sozinho.
- **Segurança**: tokens cifrados (mesma chave do 2FA, `TOTP_ENC_KEY`), nunca saem na API, na exportação nem na cópia para o modo teste (lá a conexão fica desligada). O modo teste nunca fala com o iFood.
- Caminhos da API do iFood concentrados em `backend/src/integracoes/ifood/api.js`.

### Para ligar em produção

1. Cadastro da **Calutec** (CNPJ de tecnologia) no Portal do Desenvolvedor iFood; criar o app **distribuído** do módulo de pedidos.
2. Testar com a loja de teste que o portal fornece, pedir a **homologação** e, aprovada, usar as credenciais do app de produção.
3. No servidor: `IFOOD_CLIENT_ID` e `IFOOD_CLIENT_SECRET` (ver `backend/.env.example`), `npm run migrate` (aplica a 025) e reiniciar.
4. No painel Master, liberar o módulo **iFood e 99Food** para a empresa; a empresa conecta cada loja em Lojas & PDVs.

### Testar sem o iFood (simulador)

```bash
cd backend
npm run ifood:simulador     # iFood falso em http://localhost:4999
# backend/.env: IFOOD_API_URL=http://localhost:4999 IFOOD_CLIENT_ID=sim IFOOD_CLIENT_SECRET=sim IFOOD_POLLING_SEGUNDOS=2
# fazer de conta que um cliente pediu:
curl -X POST localhost:4999/_sim/pedidos -H 'content-type: application/json' \
  -d '{"itens":[{"nome":"X-Burguer","codigo":"PRD-0002","quantidade":1,"preco":25}]}'
```

Na conexão, o "Portal do Parceiro" do simulador é o link mostrado no próprio GiroStock (ele devolve o código de autorização).

## 99Food (mesmo módulo "iFood e 99Food")

Funciona como o iFood na tela de Pedidos (mesmas etiquetas, pendências de vínculo, reserva de estoque, venda ao finalizar). As diferenças:

- **Conectar a loja** (Lojas & PDVs → "Receber pedidos da 99Food" → *Conectar 99Food*). O GiroStock mostra o **código da loja** (ex.: `GS9DF71B22C681`, o `app_shop_id`); a loja autoriza o app GiroStock no portal da 99Food informando esse código e clica em *Já autorizei*. O GiroStock confere pedindo o token da loja à 99Food.
- **Recebimento por webhook**: a 99Food avisa na hora em `POST /api/webhooks/99food` (fora do login; a autenticidade é a assinatura `didi-header-sign` = md5 do corpo + app_secret). Resposta `{"errno":0}` quando gravado; qualquer outra resposta faz a 99Food reenviar (módulo desligado, falha). Reenvio do mesmo pedido não duplica.
- **Ids de 64 bits**: os números de pedido da 99Food não cabem no número do JavaScript; são lidos e gravados como texto e enviados de volta como número.
- **Valores em centavos** na 99Food, convertidos para reais. Pago online → forma "online"; cobrado na entrega → dinheiro/cartão/Pix pelo `pay_channel`.
- **Status**: *Aceitar na 99Food* (ou aceite automático) → *Iniciar preparo* → *Marcar pronto* (avisa a 99Food: chama o entregador ou libera a retirada) → entrega da loja: *Saiu p/ entrega* envia **nome e telefone do entregador** (cadastre o telefone em Pedidos → Entregadores) / entrega da 99Food: *Retirado pela 99Food*.
- **Cancelamento** pela loja: motivo da lista; a 99Food cancela na hora e o pedido daqui também. Cancelamento do cliente cancela aqui sozinho; cancelamento parcial deixa um aviso no pedido. Não há "negociação" como no iFood.
- **Testar conexão** em Lojas & PDVs pede um token novo (token vencido é renovado sozinho). Se a loja tirar a autorização no portal, a conexão fica "Autorizar de novo".
- Ainda **não** tem a disponibilidade automática no cardápio (só iFood por enquanto).
- Caminhos e campos concentrados em `backend/src/integracoes/food99/api.js` e `mapear.js`.

### A confirmar na homologação da 99Food

A documentação oficial é fechada; o que está implementado veio de integrações abertas. Confirmar com a conta de desenvolvedor e, se preciso, ajustar só em `food99/api.js` / `food99/mapear.js`:

1. Caminhos de **aceitar** (`/order/order/confirm`) e **cancelar** (`/order/order/cancel`) e os **códigos de motivo** de cancelamento (`MOTIVOS_CANCELAMENTO`).
2. O **envelope** do webhook (`type`, `data.order_info`) e o campo do **código PDV** do item (hoje `app_item_id`/`app_external_id`).
3. Campos de **troco** e de **desconto bancado pela loja** (hoje desconto = 0).

### Para ligar em produção

1. Cadastro da **Calutec** no portal de desenvolvedores da 99Food (99Food Open Platform); criar o app e informar o webhook `https://SEU-DOMINIO/api/webhooks/99food`.
2. No servidor: `FOOD99_APP_ID` e `FOOD99_APP_SECRET` (ver `backend/.env.example`), `npm run migrate` (aplica a 027) e reiniciar. O painel Master → Configurações mostra se está configurado.
3. Liberar o módulo **iFood e 99Food** para a empresa; a empresa conecta cada loja em Lojas & PDVs. No app da 99Food para lojas, usar o modo que permite integração (app + OpenAPI).

### Testar sem a 99Food (simulador)

```bash
cd backend
npm run food99:simulador    # 99Food falsa em http://localhost:4998/v1 (manda webhooks para http://localhost:3000/api/webhooks/99food)
# backend/.env: FOOD99_API_URL=http://localhost:4998/v1 FOOD99_APP_ID=sim FOOD99_APP_SECRET=sim-segredo
# a loja "autoriza o app" (use o código mostrado no GiroStock):
curl 'localhost:4998/_sim/autorizar?app_shop_id=GS...'
# fazer de conta que um cliente pediu (preços em centavos):
curl -X POST localhost:4998/_sim/pedidos -H 'content-type: application/json' \
  -d '{"app_shop_id":"GS...","itens":[{"nome":"X-Burguer","codigo":"PRD-0002","quantidade":1,"preco":2500}]}'
```

## Relatórios avançados (tela Relatórios)

Além de **Vendas** e **Fechamentos de caixa**, a tela tem três abas novas (respeitam os filtros de período, loja, operador e pagamento; usuário restrito a lojas só vê as suas):

- **Comparativos** — vendas agrupadas por loja, operador, canal (caixa/PDV, balcão, telefone, WhatsApp, iFood, 99Food), categoria, produto, forma de pagamento, dia da semana, horário ou dia: vendas, itens, total, participação, ticket médio, lucro bruto, margem e canceladas. Exporta CSV. API: `GET /api/reports/comparativo?por=...`.
- **Indicadores** — faturamento, vendas, ticket médio, lucro e margem, itens por venda, média por dia, descontos e cancelamentos, comparados com o período anterior de mesmo tamanho (margem, descontos e cancelamentos em pontos percentuais), além de horário de pico e melhor dia da semana. API: `GET /api/reports/indicadores`.
- **Estoque** — valor do estoque por loja (a custo e a preço de venda), produtos abaixo do mínimo, produtos com saldo e sem venda no período (valor parado) e **curva ABC** (A = 80% do faturamento, B = próximos 15%, C = o resto). Exporta CSV. API: `GET /api/reports/estoque`.

Teste: `npm run test:e2e:relatorios`.

## Loja virtual (módulo "Loja virtual")

O site da loja fica **neste mesmo repositório** (`loja/`) e é **um só para todas as empresas**: o mesmo servidor atende o sistema e todas as lojas, e escolhe a loja pelo endereço acessado. Uma atualização (deploy) vale para o sistema e para todas as lojas. Os dados ficam no mesmo banco, separados por empresa. Uma loja por empresa. Permissão: **Loja virtual** (padrão só Administrador).

- **Endereço** (definido pelo Master, na ficha da empresa): subdomínio grátis `nome.<LOJA_DOMINIO_BASE>` e domínios próprios (`www.lojadocliente.com.br`). Um domínio só pode pertencer a uma empresa. O cliente aponta o DNS (CNAME do www para `LOJA_DNS_ALVO`); o Master confere o DNS pela tela. No cPanel, cada domínio próprio é adicionado como "domínio adicional/alias" do mesmo app para o AutoSSL gerar o certificado.
- **Pré-visualização:** `https://<sistema>/loja-previa/<subdominio>/` (abre mesmo com a loja fora do ar; não aceita pedido).
- **Aparência** (painel do cliente): modelo de layout (varejo: Grade, Vitrine ou Lista; cardápio digital: Cardápio), cores (com paletas prontas, incluindo a do cabeçalho), fonte, cantos, banners e blocos da página inicial (ordem, títulos). Tema exclusivo de um cliente: pasta própria em `loja/`, definida pelo Master.
- **Site da loja (`loja/`)**: vitrine com banners, categorias, destaques e promoções; busca; produto com fotos e adicionais; carrinho com cupom; conta (cadastro, login, recuperação de senha, endereços); checkout com entrega/retirada, Pix (QR code), cartão (formulário seguro do Mercado Pago) ou pagamento na entrega; acompanhamento do pedido. Pensado primeiro para celular.
- **Site externo (opcional):** a API pública `/api/loja/v1` também aceita a chave da loja (`X-Loja-Chave`), para quem quiser montar um site à parte.

Tela **Loja virtual** (gerenciamento):
- **Visão geral** — situação (publicar, pausar, tirar do ar), o que falta configurar, dados que aparecem no site (logo, contato, aviso), estabelecimento de onde sai o estoque, retirada/entrega, tempos, pedido mínimo, horários (inclusive passando da meia-noite), endereço da API e **chave da API** (mostrada uma vez; gerar outra desativa a anterior).
- **Produtos no site** — escolhe o que vai para o site (um a um ou em lote), com até 8 fotos (reduzidas no navegador), nome e descrição para o site, preço promocional com período e destaque. Preço de venda e estoque continuam os do cadastro; a disponibilidade desconta os pedidos em aberto (ficha técnica, combo e complementos pela mesma regra do PDV).
- **Cupons** — porcentagem (com teto), valor ou frete grátis; pedido mínimo, período, limite total e por cliente, só primeira compra; usos e desconto dado.
- **Pagamentos** — Pix e cartão pelo site (Mercado Pago, com as credenciais **da própria empresa**: o dinheiro cai direto na conta dela; token guardado cifrado), pagamento na entrega (dinheiro com troco, Pix, cartão), parcelas e prazo do Pix; últimos pagamentos.
- **Clientes do site** — contas (login por e-mail e senha), pedidos e total gasto; bloquear/desbloquear. Cada conta fica ligada ao cadastro de Clientes pelo telefone.
- **Entrega** — entrega da própria loja pelos bairros (taxa, tempo, pedido mínimo) e, na loja online, **envio por transportadora com o Melhor Envio**: a empresa conecta a **própria conta** (token pessoal, guardado cifrado; sandbox para testes), informa o remetente (vai na etiqueta), escolhe os serviços (Correios PAC/SEDEX, Jadlog...) e as regras (dias para separar somados ao prazo, acréscimo no frete, frete grátis no mais barato a partir de um valor, declaração de conteúdo ou NF-e) e a embalagem padrão; dá para simular a cotação. Peso e medidas de cada produto em **Produtos no site**. No site, o cliente calcula o frete pelo CEP no produto e no carrinho e escolhe o serviço no checkout (a entrega da loja só vale na cidade dela).
- **Pedidos do site** (lojas de varejo / loja online) — sem a tela de Pedidos e sem o módulo Pedidos: a preparar → em separação → embalado / pronto para retirada → enviado (transportadora, código e link de rastreio) → entregue / retirado. Lista com filtros e contadores, busca (nº, cliente, telefone, rastreio), detalhe com itens e cliente, impressão da lista de separação, correção do rastreio e cancelamento (estorna o que foi pago no site). Pedido com transportadora: **Comprar etiqueta** (paga com o saldo do Melhor Envio da empresa) e **Imprimir etiqueta**; ao enviar, a transportadora e o código vêm da etiqueta; a varredura (a cada 15 min, `LOJA_VARREDURA_ENVIOS_SEGUNDOS`) traz o código quando a transportadora só o gera na postagem e marca o pedido como **entregue** quando o Melhor Envio informa a entrega. Cancelar o pedido cancela a etiqueta ainda não postada (o valor volta para o saldo). O cliente acompanha no site e recebe e-mail quando o pedido fica pronto para retirada ou é enviado. Pago no site: vira venda quando sai (enviado ou retirado), **sem passar pelo caixa** (aparece em Vendas como "Loja virtual (site)"); a pagar na retirada/entrega: vira venda ao finalizar, no caixa aberto da loja.

**Tipo da loja** (definido pelo Master): **varejo** (loja online, aba Pedidos do site) ou **cardápio digital** (lanchonete/delivery: os pedidos caem na tela **Pedidos**, que precisa do módulo Pedidos e de "usa pedidos" no estabelecimento).

Pedidos do cardápio digital entram na tela **Pedidos** como canal "Loja virtual" (com aviso sonoro), reservam o estoque e viram venda ao finalizar, com o preço promocional e o desconto do cupom. Pago pelo site: o preparo só começa com o pagamento aprovado; Pix não pago no prazo cancela o pedido sozinho; cancelar pedido pago estorna no Mercado Pago. Os avisos de pagamento chegam em `/api/webhooks/mercadopago/<loja>` (conferidos na API do Mercado Pago e, com o segredo cadastrado, pela assinatura).

Documentação da API: [docs/API_LOJA_VIRTUAL.md](docs/API_LOJA_VIRTUAL.md). Variáveis novas no `.env`: `URL_PUBLICA`, `SMTP_*`, `LOJA_DOMINIO_BASE`, `LOJA_DNS_ALVO`, `LOJA_DNS_IP` (veja `.env.example`). Desenvolvimento do site: `cd loja && npm install && npm run build` (o backend serve `loja/dist`). Teste: `npm run mp:simulador` + `npm run me:simulador` (Melhor Envio, porta 4996; no `.env`: `ME_API_URL=http://localhost:4996`) + `npm run test:e2e:loja-virtual`. Antes de usar o Melhor Envio em produção, confira a integração com uma conta **sandbox** do Melhor Envio (a integração foi feita sobre a API v2 e testada com o simulador). Variável `ME_CONTATO`: e-mail de contato técnico enviado ao Melhor Envio.

## Financeiro (módulo "Financeiro")

Liberado pelo Master por plano ou por empresa; acesso pela permissão **Financeiro** (perfis Administrador e Financeiro; dá para liberar a outros usuários em Usuários). Menu **Financeiro**, com as abas:

- **Resumo**: saldo de hoje (soma das contas), a pagar (vencido, hoje, 7 dias), a receber em 7 dias (contas + vendas no cartão/apps a cair), resultado do mês, saldo previsto dos próximos 30 dias (com o menor saldo e o dia) e o que está vencendo.
- **Contas a pagar / a receber**: lançamento único, **parcelado** (divide o valor; centavos na 1ª parcela) ou **todo mês** (mesmo valor, ex.: aluguel), com categoria, fornecedor/cliente, loja, documento e mês de competência. Pagar/receber com data, valor (juros ou desconto), conta e forma; estornar; editar (só em aberto); cancelar com motivo (opção de cancelar as parcelas seguintes). Nada é apagado; tudo fica na auditoria. Em "a receber", também as **vendas a cair** no cartão e nos apps.
- **Fluxo de caixa**: dia a dia, realizado até hoje e previsto depois (vendas no cartão/apps a cair + contas em aberto pelo vencimento; atrasadas entram em hoje), com o saldo no fim de cada dia.
- **Resultado do mês** (competência): vendas − descontos − taxas de cartão/apps − custo das mercadorias vendidas = lucro bruto; − despesas por categoria + outras receitas = resultado. Filtro por loja e evolução de 6 meses.
- **Cadastros**: **contas** (banco, cofre, carteira digital) com saldo de um dia; **formas de pagamento das vendas** (em quantos dias cai, taxa % e em qual conta — crédito, débito, pix, dinheiro, iFood, 99Food); **categorias** de despesa e receita.

Regras:
- As **vendas não viram lançamentos**: o financeiro lê as vendas do PDV/pedidos e calcula quando e quanto cai, pelo prazo e taxa da forma de pagamento. Venda paga online é separada em iFood/99Food pelo pedido de origem.
- **Compra de mercadorias** fica fora do resultado (o custo dela já entra pelo custo das mercadorias vendidas; contar as duas vezes seria em dobro), mas entra no fluxo de caixa.
- **NF-e → contas a pagar**: ao importar o XML da nota (Produtos & Estoque → Entrada por nota), quem tem o Financeiro vê as **duplicatas** da nota (número, vencimento, valor) prontas para lançar como contas a pagar do fornecedor, na categoria Compra de mercadorias. Nota sem duplicata: uma parcela com o total, em 30 dias (ajustável).
- Datas pelo fuso de São Paulo (o "hoje" vem do servidor, não do relógio do aparelho).

## Teste ponta a ponta

```bash
cd backend
API_URL=http://localhost:3000 npm run test:e2e:ifood     # iFood (com o simulador rodando e a API apontando para ele)
API_URL=http://localhost:3000 npm run test:e2e:99food    # 99Food (idem, com o simulador da 99Food)
API_URL=http://localhost:3000 npm run test:e2e:combos    # combos e complementos
API_URL=http://localhost:3000 npm run test:e2e:financeiro # financeiro (contas, fluxo, resultado)
```


```bash
cd backend
API_URL=http://localhost:3000 npm run test:e2e:modulos   # módulos por plano/empresa
```

Com um banco de teste recém-criado (`npm run migrate && npm run seed`) e a API rodando:

```bash
cd backend
API_URL=http://localhost:3000 npm run test:e2e
```

Cobre fornecedores, produtos, estoque por loja, transferências, vendas, cancelamento, permissões por loja e isolamento entre empresas. Ele cria uma empresa de teste no banco, então não use em produção.

## Login de exemplo (gerado pelo seed)

- E-mail: `admin@girostock.local`
- Senha: `admin123`

## Estrutura

```
backend/   API Node.js + PostgreSQL (migrations em src/db/migrations)
frontend/  PWA React (telas: PDV, Produtos & Estoque, Insumos, Fornecedores, Lojas & PDVs, Usuários, Relatórios)
nginx/     Proxy reverso
```

## Regras de negócio centrais

- Multi-tenant desde a base: toda tabela relevante tem `tenant_id`.
- Estoque de produto por local (`stock_balances`), toda alteração passa por `stock_movements`.
- Venda com ficha técnica valida e debita insumos e produto na mesma transação de banco (tudo ou nada).
- Não é possível vender com o caixa fechado.
- Sangria nunca deixa o saldo esperado do caixa negativo.
- Auditoria (`audit_logs`) registra alterações relevantes de estoque, preço, caixa e permissões.
- Todo id recebido (produto, local, fornecedor, categoria, insumo, terminal) é conferido contra a empresa do usuário logado.
- Erros de dados inválidos viram respostas 4xx; o servidor não cai por causa de uma requisição ruim.

### Fornecedores

- CPF/CNPJ com dígito verificador validado; aceita digitação com pontuação (salvo só com dígitos).
- Edição e desativação (o fornecedor inativo some dos novos vínculos, mas o histórico fica).
- Um produto pode ter vários fornecedores (`product_suppliers`); `products.supplier_id` é o principal.
- Toda entrada de estoque pode registrar fornecedor, custo unitário e nota fiscal. Comprar de um fornecedor já o vincula ao produto.

### Estoque por loja

- Produtos e insumos têm saldo por local (`stock_balances` e `ingredient_balances`) e estoque mínimo por local, com alertas em `GET /api/stock/alerts`.
- Entrada com custo unitário recalcula o custo do produto pela média ponderada; a entrada é recusada se o custo médio ficar maior ou igual ao preço de venda.
- Transferências travam os saldos sempre na mesma ordem (sem deadlock entre transferências opostas).
- Produtos vendidos em `UN`/`CX` só aceitam quantidades inteiras.
- Lojas e PDVs são criados, renomeados e desativados na tela "Lojas & PDVs". Uma loja só é desativada sem estoque e sem caixa aberto.

### Vendas

- Linhas repetidas do mesmo produto são somadas antes de validar o estoque.
- A venda baixa o estoque (ou os insumos da ficha técnica) da loja do PDV e grava o custo de cada item, usado no lucro bruto dos relatórios.
- Administrador ou Gerente cancelam vendas enquanto o caixa da venda estiver aberto; o cancelamento devolve produtos e insumos ao estoque e tira o valor do caixa.

### Usuários e lojas

- O e-mail de login é único no sistema todo.
- Usuário com loja de atuação definida só vende, movimenta estoque e vê relatórios daquela loja (Administrador sempre vê tudo). Em transferências, ele envia a partir da própria loja.
- Desativar um usuário ou trocar seu perfil/loja vale na hora, sem novo login.

### Migração `004_estoque_fornecedores_vendas.sql`

- O saldo de insumos que era global vai para o local cujo nome contém "lanchonete" (ou, se não houver, o local mais antigo da empresa).
- A migração é interrompida se houver usuários com o mesmo e-mail em empresas diferentes; ajuste esses e-mails antes de aplicá-la.

Consulte [REGRAS_E_ETAPAS.md](REGRAS_E_ETAPAS.md) para o escopo completo do projeto.

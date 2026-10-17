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
| iFood e 99Food *(em breve)* | pedidos das plataformas na tela de Pedidos | Pedidos |
| Casa de shows e eventos *(em breve)* | eventos, PDVs e estoque do evento | PDV |
| Loja virtual *(em breve)* | catálogo online e delivery | — |
| Financeiro *(em breve)* | contas a pagar/receber e fluxo de caixa | — |

- Sempre incluído em qualquer plano: Início, Produtos & Estoque, Fornecedores, Lojas & PDVs, Usuários e Relatórios.
- Planos prontos: **Só PDV** (varejo/distribuidora), **Lanchonete**, **Básico** e **Completo**. O Master cria novos planos e remove os que nenhuma empresa usa (o Completo é o padrão e não pode ser removido).
- Ligar um módulo liga junto o que ele precisa; desligar desliga junto o que depende dele. O servidor recusa combinações inválidas.
- Módulo desligado vale **na hora** para todos os usuários da empresa, inclusive o Administrador: some do menu e das telas, e a API responde 403 ("não faz parte do plano"). As permissões desses módulos também somem da tela de usuários.
- Módulos "em breve" já podem ser liberados: passam a valer quando ficarem prontos.
- Catálogo em `backend/src/config/modulos.js`. A migração `024_modulos_por_plano.sql` não muda nada para quem já usa: os planos existentes mantêm PDV e Lanchonete, Pedidos/Clientes seguem como estavam.

## Teste ponta a ponta

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

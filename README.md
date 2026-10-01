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

## Teste ponta a ponta

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

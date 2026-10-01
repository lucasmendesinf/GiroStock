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

- A busca só mostra produtos com estoque na loja do PDV; a quantidade no carrinho é limitada ao saldo.
- A quantidade pode ser digitada no carrinho (produtos em KG/L abrem o campo de peso ao serem adicionados).
- Desconto em R$ ou %, botão "valor exato" e troco calculado na hora.
- Cada venda recebe um número curto e sequencial por empresa (Venda nº 123).
- No PDV o menu do sistema fica escondido (modo caixa) para o operador não sair da venda sem querer.

### Telas

- O menu mostra só as telas que o nível de acesso permite; quem abre uma tela sem permissão vê um aviso.
- Quem só vende cai direto no PDV; os demais no **Início** (vendas de hoje, alertas de estoque, caixas abertos).
- **Produtos**: tabela com busca (nome, código PRD ou EAN), filtros por categoria, fornecedor, situação e estoque baixo; cadastro em janela.
- **Entrada por nota**: vários produtos de uma compra lançados de uma vez (aceita leitor), com fornecedor e número da nota.
- **Insumos**: um botão "Movimentar" por insumo (entrada, saída, transferência, balanço e mínimo), já na loja que tem saldo.
- **Relatórios**: período (hoje, ontem, 7 dias, mês, mês passado ou datas), ranking de produtos, descontos, histórico paginado e fechamentos de caixa (esperado × contado).
- **Usuários**: nível padrão Caixa, permissões extras por usuário, confirmação ao mudar acesso, edição de nome e redefinição de senha; cada usuário troca a própria senha no menu da conta. A aba **Níveis de acesso** cria e configura os níveis.
- Valores e quantidades no padrão brasileiro (R$ 1.234,56), avisos no canto da tela e confirmação em ações que desativam ou cancelam algo.
- Funciona em celular e tablet (menu recolhível e tabelas que escondem colunas secundárias).

## Níveis de acesso e permissões

Cada usuário tem um **nível de acesso** (lista de permissões) e, opcionalmente, **permissões extras** só para ele. O Administrador cria níveis novos e ajusta os padrões em **Usuários → Níveis de acesso**; a mudança vale na hora para todos do nível.

| Permissão | O que libera |
|---|---|
| `vendas.pdv` | Usar o PDV: vender, abrir e fechar caixa, sangria e suprimento |
| `vendas.desconto` | Dar desconto nas vendas |
| `vendas.cancelar` | Cancelar vendas (estorna estoque e caixa) |
| `estoque.ver` | Ver produtos, estoque, fornecedores e insumos |
| `estoque.movimentar` | Entradas, saídas, transferências, notas e balanço de insumos |
| `produtos.criar` / `produtos.editar` | Cadastrar / editar produtos e categorias (nome, descrição, preços, código de barras, fornecedores, ficha técnica, estoque mínimo, desativar) |
| `fornecedores.criar` / `fornecedores.editar` | Cadastrar / editar e desativar fornecedores |
| `insumos.criar` / `insumos.editar` | Cadastrar / editar insumos (nome, unidade, custo, estoque mínimo) e desativar |
| `relatorios.ver` | Relatórios e fechamentos de caixa |
| `lojas.gerenciar` | Lojas e PDVs |
| `usuarios.gerenciar` | Usuários (só concede permissões que a própria pessoa tem) |

Níveis padrão: **Administrador** (tudo, não pode ser alterado), **Gerente**, **Caixa/Operador**, **Estoque**, **Financeiro** e **Lanchonete/Cozinha**. Por padrão **só o Administrador edita** produtos, fornecedores, insumos e categorias; os demais níveis cadastram, e a edição é liberada pelo Administrador no nível ou por usuário.

Regras de segurança: só o Administrador configura níveis e atribui o nível Administrador; ninguém concede uma permissão que não tem; a empresa sempre mantém ao menos um Administrador ativo; o Administrador não rebaixa a si mesmo.

### Migração `006_niveis_de_acesso.sql`

- Cria os níveis padrão em cada empresa e coloca cada usuário no nível equivalente ao perfil que ele tinha.
- Troca a coluna `perfil` por `access_level_id` + `permissoes_extra` e cria `products.descricao`.

### Migração `005_ux_vendas_numero_desconto.sql`

- Numera as vendas existentes por empresa, na ordem em que foram feitas, e cria os campos de subtotal e desconto.

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
- Quem tem a permissão "Cancelar vendas" cancela enquanto o caixa da venda estiver aberto; o cancelamento devolve produtos e insumos ao estoque e tira o valor do caixa.

### Usuários e lojas

- O e-mail de login é único no sistema todo.
- Usuário com loja de atuação definida só vende, movimenta estoque e vê relatórios daquela loja (Administrador sempre vê tudo). Em transferências, ele envia a partir da própria loja.
- Desativar um usuário ou trocar seu nível, permissões ou loja vale na hora, sem novo login.

### Migração `004_estoque_fornecedores_vendas.sql`

- O saldo de insumos que era global vai para o local cujo nome contém "lanchonete" (ou, se não houver, o local mais antigo da empresa).
- A migração é interrompida se houver usuários com o mesmo e-mail em empresas diferentes; ajuste esses e-mails antes de aplicá-la.

Consulte [REGRAS_E_ETAPAS.md](REGRAS_E_ETAPAS.md) para o escopo completo do projeto.

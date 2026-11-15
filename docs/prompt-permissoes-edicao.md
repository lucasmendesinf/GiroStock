# Prompt — Permissões de edição de cadastros e proteção contra escalada de acesso

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Origem: a branch antiga `origin/claude/permissoes-edicao` (um commit de 01/10, `09169bb`, **não mesclado**) trouxe boas ideias, mas num desenho **incompatível** com o sistema atual (tabela `access_levels` substituindo os perfis). **Não mescle nem faça cherry-pick dessa branch.** Aproveite só as **ideias**, implementadas em cima do sistema de permissões **atual** (matriz de perfis + ajustes por usuário). Se quiser consultar a branch: `git show origin/claude/permissoes-edicao:<arquivo>`.

---

## 1. Objetivo

1. **Separar "criar" de "editar" cadastros**: hoje quem tem a permissão `Estoque` cria **e edita** produtos, fornecedores, insumos e categorias. Passa a existir permissão própria para **editar**, com padrão **só Administrador** (e liberável por usuário).
2. **Proteção contra escalada de acesso** na gestão de usuários: ninguém concede o que não tem; só Administrador mexe em Administrador; a empresa **nunca fica sem Administrador ativo**.
3. Pequenos recursos que a branch trazia e a `main` não tem (confirmar no código antes): **descrição do produto**, **renomear categoria**, **editar/ativar/desativar insumo** pela tela, **PDV sem campo de desconto** para quem não pode dar desconto.

Decisões já tomadas (não rediscutir):
- **Não** criar tabela de "níveis de acesso" nem remover o enum de perfis. Continua: perfil (padrão) + ajustes por usuário (`users.permissoes`, `normalizarOverrides`, `areasEfetivas`).
- **Padrão**: editar cadastros só com **Administrador**. Para **não quebrar a operação de hoje**, usuários **já existentes** que editam hoje **mantêm** a capacidade por um ajuste individual criado na migration (o administrador poderá revogar depois). Usuários **novos** seguem o padrão novo.
- Criar cadastros continua em `Estoque`; mover estoque, entradas, transferências, balanço de produto e mínimo continuam em `Estoque`.

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador (incluindo 375 px nas telas tocadas) e por requisições reais; build não basta.
- Antes de criar migrations: `ls backend/src/db/migrations` e use o **próximo número livre** (a última conhecida é `035_grades_variacoes.sql`).
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Não quebre** vendas, PDV, caixa, estoque, financeiro, pedidos, loja virtual, garçom, Master, modo teste, suporte. Rode as suítes `backend/scripts/e2e-*.mjs` (cada uma em banco recém-criado; algumas dependem de simuladores) e **compare com o que passava antes**.
- Estilo: paleta atual, temas claro e escuro. Toda consulta filtra por `tenant_id`.

## 3. Estado atual (leia antes; confirme no código)

- `backend/src/middleware/permissions.js`: `MATRIX` (perfis → áreas), `PERMISSOES` (áreas ajustáveis por usuário, com descrição), `areasEfetivas(perfil, overrides, …)`, `normalizarOverrides` (guarda só o que difere do padrão do perfil), `requireArea`. Máscara por **módulos** do plano/empresa (`config/modulos.js`). Perfis: Administrador, Gerente, Caixa/Operador, Estoque, Lanchonete/Cozinha, Financeiro, Garçom, Master (Master/Garçom não gerenciam cadastros).
- Rotas de cadastro protegidas só por `requireArea('Estoque')`: `routes/products.routes.js` (`POST/PUT/PATCH /products…`, status, ficha técnica `…/ingredients`, `DELETE /categories/:id`), `routes/ingredients.routes.js` (`POST/PUT/DELETE /ingredients…`, balanço, mínimo), `routes/suppliers.routes.js` (`POST/PUT/PATCH /suppliers…`). Há também rotas de complementos/combos e de produtos da loja virtual (`LojaVirtual`): **avalie** e decida onde se aplicam (ver 5.1).
- `routes/users.routes.js` (área `Configuracoes`): `GET /users/permissoes`, `GET/POST /users`, `PATCH /users/:id`, senha e status. A tela `pages/Users.jsx` monta a grade de permissões a partir de `GET /users/permissoes` (novas áreas aparecem sozinhas). Rotas equivalentes do painel Master em `routes/master*.js` criam usuários nas empresas.
- Front: `frontend/src/utils/permissions.js` (`podeAcessar`, `temModulo`), telas `pages/produtos/*` (`ListaProdutos`, `FormProduto`, `DetalheProduto`/`EditarProduto`, `Insumos`, `Categorias`…), `pages/Suppliers.jsx`, `pages/PDV.jsx`.
- **Não existem hoje**: proteção anti-escalada, trava do último Administrador, campo `products.descricao`, renomear categoria (verifique `grep`), nem permissões separadas de editar.

## 4. O que a branch antiga fazia (referência de **intenção**, não de código)

- Permissões granulares: criar × editar para produtos, fornecedores e insumos; "editar" por padrão só no Administrador.
- **Anti-escalada**: "você não pode conceder permissões que não tem"; **só Administrador** atribui/edita o nível Administrador; "a empresa precisa ter ao menos um Administrador ativo".
- Edição de insumo (nome, unidade, custo, mínimo) e ativar/desativar; renomear categoria; descrição do produto; balanço que **muda custo** exige permissão de editar insumos.
- PDV sem campo de desconto para quem não tem a permissão; botões de editar **ocultos** para quem não pode (o servidor continua sendo a trava).

## 5. O que fazer

### 5.1 Novas permissões de edição (back-end)
- Em `PERMISSOES` e `MATRIX`: `EditarProdutos` ("Editar produtos e categorias: nome, descrição, preços, código de barras, fornecedores, ficha técnica, ativar/desativar"), `EditarFornecedores` ("Editar fornecedores e desativar"), `EditarInsumos` ("Editar insumos: nome, unidade, custo; ativar/desativar; balanço que altera o custo"). Padrão por perfil: **Administrador `true`; todos os demais `false`** (inclua as chaves em **todas** as linhas da matriz, como foi feito com `LojaVirtual`, Garçom e Master).
- Máscara de módulos: são áreas do núcleo (sempre ligadas, como `Estoque`); não precisam de módulo.
- Aplicar nas rotas (use `requireArea('EditarX')` **além** de `requireArea('Estoque')` onde fizer sentido):
  - **Produtos**: `PUT/PATCH /products/:id`, `PATCH /products/:id/status`, ficha técnica (`POST/DELETE …/ingredients`), renomear/excluir categoria → `EditarProdutos`. **Criar** produto/categoria continua `Estoque`. Mínimo por loja (`PUT /products/:id/minimum`) e movimentações continuam `Estoque`.
  - **Fornecedores**: `PUT /suppliers/:id`, `PATCH /suppliers/:id/status` → `EditarFornecedores`.
  - **Insumos**: `PUT /ingredients/:id`, `DELETE`/desativar, e o **ajuste de saldo/balanço quando altera o custo** → `EditarInsumos`; entradas/saídas/transferências/mínimo continuam `Estoque`.
  - **Complementos/combos** e produtos da **loja virtual**: avalie; sugestão — editar complementos/combos = `EditarProdutos`; a vitrine da loja virtual continua sob `LojaVirtual`. **Documente** o que decidiu.
  - Resposta de erro clara (403) dizendo qual permissão falta.
- **Migration** (próximo número livre): para **cada usuário existente** cujo perfil hoje tem `Estoque` (Gerente, Estoque, Lanchonete/Cozinha e Administrador não precisa) e que **não** é Administrador, grava no JSONB `users.permissoes` os ajustes `EditarProdutos/EditarFornecedores/EditarInsumos = true` (mesclando com ajustes já existentes, sem apagar nada). Resultado: **nada muda para quem já usa o sistema**. Usuários novos nascem com o padrão novo. Teste que a migration é idempotente e funciona em banco com e sem ajustes prévios.
- `GET /auth/me`/login já devolvem as áreas efetivas: garanta que as novas chaves chegam ao front.

### 5.2 Proteção contra escalada e último Administrador (back-end)
Aplicar em `routes/users.routes.js` **e** nas rotas de usuário do painel Master (`routes/master*.js`; o Master pode tudo, mas respeite a regra do último Administrador):
- **Ninguém concede o que não tem**: ao criar/editar usuário ou mudar perfil, as áreas efetivas **resultantes** do alvo (perfil + ajustes) devem ser um **subconjunto** das áreas efetivas de quem está agindo. Violação → 403 "você não pode conceder permissões que não tem: …".
- **Só Administrador** cria usuário com perfil Administrador, promove alguém a Administrador ou **edita/desativa/redefine a senha** de um Administrador. Gerente/outros não.
- **Nunca sem Administrador**: recusar (400) rebaixar/desativar/mudar perfil do **último Administrador ativo** da empresa (checar dentro da transação, com lock, para evitar corrida entre duas edições simultâneas).
- Ninguém altera as **próprias** permissões/perfil para ampliar o próprio acesso.
- Auditoria (`logAudit`) de toda mudança de perfil/permissão (quem mudou, de quê, para quê).

### 5.3 Pequenos recursos (confirme no código se já existem; só faça o que faltar)
- **Descrição do produto**: coluna `products.descricao TEXT` (migration), campo no cadastro/edição, exibida no detalhe; limite razoável de tamanho; editável só com `EditarProdutos`.
- **Renomear categoria** (`PATCH /categories/:id`, nome único por empresa, `EditarProdutos`), com a mesma validação de duplicidade da criação.
- **Insumos**: tela com **editar** (nome, unidade, custo), **ativar/desativar** e mínimo, respeitando permissões; unidade só muda se não houver saldo/consumo que a quebre (siga a regra que a API já tiver).
- **PDV**: o campo/ação de **desconto só aparece** para quem tem `Desconto` (o servidor já deve recusar sem a permissão; confirme).

### 5.4 Front-end
- **Esconder/desabilitar** botões e campos de edição (lápis, "Editar", "Desativar", renomear categoria, editar insumo/fornecedor, editar ficha técnica, campo de descrição) para quem **não** tem a permissão correspondente — o servidor continua sendo a trava (403 tratado com mensagem amigável).
- `Users.jsx`: a grade já lista as áreas ajustáveis; confirme que as 3 novas aparecem agrupadas com `Estoque` e com a descrição clara; mostrar o **padrão do perfil** e quando o usuário foi **personalizado** (já existe o selo "personalizado").
- Ao criar/editar usuário: **desabilitar** na interface as permissões que quem está logado não tem (o servidor também recusa), e esconder a opção "Administrador" para quem não é Administrador; mensagem clara ao tentar tirar o último Administrador.
- Estilo e responsividade (375 px) nas telas tocadas; temas claro e escuro.

## 6. Testes obrigatórios (rodar e mostrar o resultado)

Crie `backend/scripts/e2e-permissoes-edicao.mjs` (padrão dos e2e existentes) e teste no navegador:

1. **Padrão novo**: usuário novo com perfil Gerente/Estoque **não** edita produto/fornecedor/insumo (403) mas **cria** e movimenta estoque; Administrador edita tudo.
2. **Ajuste individual**: conceder `EditarProdutos` a um Estoque → edita produtos, **continua sem** editar fornecedor/insumo; revogar → volta a 403; cada uma das 3 permissões é independente.
3. **Migration preserva o hoje**: em banco com um Gerente e um Estoque antigos (criados antes da migration), após migrar **eles ainda editam**; reexecutar a migration não duplica nem altera; usuários criados depois seguem o padrão novo.
4. **Anti-escalada**: Gerente não concede `EditarProdutos` (que não tem); não promove ninguém a Administrador; não edita/desativa/redefine senha de Administrador; ninguém amplia a própria permissão; Administrador concede o que quiser.
5. **Último Administrador**: tentar rebaixar, desativar ou mudar o perfil do único Administrador ativo → 400; com **dois** pedidos simultâneos tentando tirar os dois últimos, **um** deve falhar (corrida); com um segundo Administrador ativo, passa. O painel Master também respeita.
6. **Descrição do produto**, **renomear categoria** (duplicado → 409), **editar/ativar/desativar insumo**, balanço que altera custo (exige `EditarInsumos`), PDV sem desconto sem a permissão.
7. Front: botões de edição somem sem permissão; a grade de permissões do usuário mostra as novas; sem rolagem horizontal em 375 px; temas claro e escuro.
8. **Regressão**: todas as suítes e2e existentes (estoque-vendas, módulos, combos, garçom 1–3, financeiro, relatórios, iFood, 99Food, loja virtual, dados-empresa, master 1–4, 2FA, redefinir-senha, modo-teste) — **compare com a execução anterior**; se alguma dependia de um perfil não-Administrador editar cadastro, ajuste o **teste** (não o comportamento) e relate.

## 7. Fora do escopo

Níveis/perfis **personalizados** por empresa (tabela `access_levels`), remoção do enum de perfis, permissões por loja, aprovação em dois passos de alterações, histórico de versões dos cadastros, portal de auditoria de permissões (a auditoria já grava).

## 8. Ordem sugerida de commits

1. Permissões `EditarProdutos/Fornecedores/Insumos` na matriz + aplicação nas rotas. 2. Migration que preserva os usuários existentes. 3. Anti-escalada e último Administrador (usuários + Master). 4. Descrição do produto, renomear categoria, insumos (editar/ativar/desativar). 5. Front: esconder edição, grade de permissões, usuário. 6. PDV sem desconto (se faltar). 7. e2e novo e ajustes de testes antigos.

## 9. Entrega

Rode os testes da seção 6 e faça um **relatório em português**: o que foi feito por commit, decisões (onde cada permissão se aplica, complementos/combos, loja virtual), **lista das rotas que passaram a exigir as novas permissões**, resultados (inclusive falhas), pendências e qualquer funcionalidade existente que você **não removeu** mas notou conflito. Avise claramente que, por padrão, **usuários novos** não editam cadastros e que os **antigos foram preservados** pela migration.

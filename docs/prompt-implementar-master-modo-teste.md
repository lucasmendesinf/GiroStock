# Prompt — Perfil "Master" + Modo teste (banco de teste separado)

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Não há preview de tela para esta entrega (decisão do cliente). O preview `docs/master-preview/preview-master.html` é o **painel Admin Master completo, uma etapa futura**: use-o só como referência de estilo (paleta e estrutura) para a página mínima `/master` descrita aqui.

---

## 1. Objetivo

1. Criar o perfil **Master** (dono da plataforma): fica **fora de qualquer empresa**, não opera vendas/estoque de empresas e só é criado por **script** (nunca pela tela de usuários).
2. Criar o **Modo teste**: um **segundo banco de dados** (`girostock_teste`) com a mesma estrutura, para testar sem afetar a produção. Quem ligar o modo teste passa a trabalhar **apenas no banco de teste**; nada do que fizer aparece em produção. As demais sessões (outros usuários) continuam na produção normalmente.
3. Permissão **"Modo teste"** por usuário (padrão: só o Master; pode ser liberada a outros nas permissões do usuário).

Decisões já tomadas pelo cliente (não rediscutir):
- O modo teste vale para o **sistema todo** (um único banco de teste, todas as empresas copiadas).
- Na **primeira ativação** o banco de teste é criado/migrado e recebe **uma cópia completa da produção**. Depois disso o teste mantém os próprios dados; existe o botão **"Copiar tudo da produção"**, que **substitui o banco de teste inteiro** (confirmação digitando `COPIAR`). A cópia é só **produção → teste**, nunca o contrário.
- Só vale para a **sessão que ativou**. Quem não ativou segue em produção.
- **Usuário pertence a uma única empresa** (não compartilha entre empresas) e pode atuar em várias lojas da mesma empresa (já funciona via `user_locations`). **Administrador continua vendo todas as lojas da empresa.** Não alterar nada disso.

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: mantenha e liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador (`npm run dev` em `frontend` e `backend`) e por requisições reais; build não basta.
- Antes de rodar, depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Não quebre** login, PDV, pedidos, clientes, relatórios. Teste a venda direta e o login de um usuário comum depois de mexer no acesso ao banco.
- Antes de criar migrations, rode `ls backend/src/db/migrations` e use o **próximo número livre** (a última conhecida é `014_clientes.sql`; outra sessão pode ter criado mais).
- **Nunca** imprima/registre senhas, tokens ou a `DATABASE_URL*` em log, resposta de API ou relatório.

## 3. Estado atual (para se localizar)

- `backend/src/db/pool.js`: um único `pg.Pool` (`DATABASE_URL`), importado diretamente por todas as rotas (`require('../db/pool')`, ~250 consultas, mais `pool.connect()` em transações). **Não reescreva as consultas**: troque o banco num ponto só (ver 5.2).
- `backend/src/middleware/auth.js` (`authRequired`): valida o JWT, **recarrega o usuário do banco a cada requisição** (usuário inativo perde acesso na hora) e monta `req.user` (`tenantId`, `perfil`, `locationIds`, `areas`).
- `backend/src/middleware/permissions.js`: `MATRIX` por perfil, `PERMISSOES` (ajustáveis por usuário), `areasEfetivas`, `normalizarOverrides`, `requireArea`. Enum `user_role` no PostgreSQL com os perfis atuais.
- `users.tenant_id` é **NOT NULL**; e-mail único no sistema (`uq_users_email`). Muitas consultas assumem `req.user.tenantId`.
- `backend/scripts/usuarios.js` lista/redefine usuários por script; `backend/scripts/e2e-estoque-vendas.mjs` é o teste de ponta a ponta existente (cria uma "Empresa B" para testar isolamento).
- Frontend: `context/AuthContext.jsx`, `App.jsx` (topbar/menu, `Protegida`), `pages/Users.jsx` (matriz de permissões por usuário), `components/Cupom.jsx` (cupom/comanda).

## 4. Perfil Master

### 4.1 Dados e criação
- Migration (arquivo próprio): `ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Master';` (em migration separada de qualquer uso do valor novo, pois o PostgreSQL não deixa usar o valor na mesma transação).
- Como `users.tenant_id` é NOT NULL e dezenas de consultas dependem dele, **não torne a coluna nula**. O Master pertence a uma empresa especial **"Plataforma"** (linha em `tenants`, sem lojas, sem produtos) criada pelo script.
- Script `backend/scripts/master.js` + `npm run master` (padrão do `usuarios.js`): lê `MASTER_EMAIL`, `MASTER_PASSWORD`, `MASTER_NOME` do **ambiente** (digitados por quem administra; nunca em arquivo versionado nem impressos), cria a empresa "Plataforma" se não existir e cria/atualiza o usuário Master (senha com bcrypt, mínimo 8 caracteres, `ativo=true`). Idempotente. Imprime só "master criado/atualizado: <nome> <email>".
- O Master **nunca** pode ser criado, promovido, editado, desativado ou listado pela tela/API de usuários: em `routes/users.routes.js` filtre `perfil <> 'Master'` nas listagens e **rejeite (403)** qualquer criação/edição que envolva o perfil `Master`; `Users.jsx` não oferece "Master" no seletor de perfil.

### 4.2 Permissões
- `MATRIX['Master']`: todas as áreas de empresa (`Vendas`, `Estoque`, `Relatorios`, `Pedidos`, `Clientes`…) **false**; novas áreas `Master: true` e `ModoTeste: true`.
- Nos demais perfis adicione `Master: false` e `ModoTeste: false`.
- `PERMISSOES`: acrescente `ModoTeste: 'Modo teste: trabalhar em um banco de teste separado da produção'` (ajustável por usuário, aparece na matriz de permissões de `Users.jsx`). **`Master` não entra em `PERMISSOES`** (não pode ser concedida por ajuste individual). Garanta que `normalizarOverrides` continue ignorando/recusando a chave `Master`.
- Novo `requireArea('Master')` protege as rotas `/api/master/*`.

### 4.3 Acesso e tela mínima
- Login do Master usa o mesmo endpoint de login. `GET /api/auth/me` devolve também `master: true/false` e `modoTeste: true/false`.
- Frontend: o Master vê no menu **só "Master"** (e sair). Página `/master` mínima, no estilo dos previews (paleta atual, tema claro/escuro), com a seção **Modo teste** (item 5.4) e um aviso "Demais ferramentas do painel Master virão em etapa futura". **Não** implemente o painel completo (empresas, backups, auditoria global etc.).
- Em produção o Master **não opera dados de empresas** (as rotas de negócio já exigem áreas que ele não tem).

## 5. Modo teste

### 5.1 Configuração e banco de teste
- Nova variável `DATABASE_URL_TESTE` (documente em `.env.example` e nos arquivos de deploy/Docker; no Docker, o init deve criar o banco `girostock_teste`).
- **Trava de segurança:** se `DATABASE_URL_TESTE` estiver ausente **ou igual** a `DATABASE_URL` (mesmo host/porta/banco), o modo teste fica **indisponível** (API responde 409 "modo teste não configurado") — nunca cair na produção por engano. Valide isso na inicialização e a cada troca.
- O script de migrations existente passa a rodar **nos dois bancos** (produção e teste). Extensões (ex.: `citext`) criadas nos dois.

### 5.2 Escolha do banco por requisição (sem reescrever consultas)
- Use `AsyncLocalStorage` (módulo `async_hooks`): em `db/pool.js` exporte um objeto compatível (`query`, `connect`, `on`, `end`) que **delega ao pool do contexto atual**: contexto "teste" → pool de `DATABASE_URL_TESTE`; sem contexto → pool de produção (comportamento atual, inclusive jobs/scripts/workers). Mantenha `require('../db/pool')` funcionando em todo o código.
- O contexto é definido **em um único lugar**: `authRequired`, depois de validar o token, executa o restante da requisição dentro de `als.run({ modo: 'teste' }, next)` quando o token for de teste.
- `authRequired` **sempre carrega o usuário do banco de produção** (fonte de verdade de login, ativo/inativo e permissões), mesmo em modo teste; só depois seleciona o banco de negócio. Assim, desativar um usuário em produção corta o acesso ao teste também.
- Rotas de login/`auth/me`/`master`/ativação do modo teste e a lista de usuários para autenticação usam sempre produção.

### 5.3 Token e permissão
- `POST /api/auth/modo-teste` `{ ativo: true|false }`: o modo teste vale para o **usuário logado, nesta sessão** (não há escolha de empresa). Exige a área **`ModoTeste`** (checada em produção, a cada chamada) e devolve um **novo JWT** com `modo: 'teste'` (ou sem a claim ao desligar). O servidor **revalida a permissão `ModoTeste` em toda requisição** feita com token de teste; se foi retirada, responde 401/403 e o front volta para produção.
- **Usuário comum com a permissão**: em modo teste continua na **própria empresa e lojas**, só que no banco de teste.
- **Master** (empresa "Plataforma", sem dados de negócio): continua sendo Master dentro do banco de teste. Vê a página `/master` e faz a **cópia da produção**; **não** escolhe empresa. Para testar PDV, vendas e pedidos usa-se o login de um **usuário de empresa com a permissão `ModoTeste`** (ex.: um Administrador), que no teste enxerga a própria empresa e lojas.
- Garanta que o usuário logado **exista no banco de teste** (FKs como `operador_id`): ao ativar o modo teste faça `INSERT … ON CONFLICT DO NOTHING/UPDATE` do usuário (e de sua empresa/lojas, se necessário) no banco de teste. Usuários criados dentro do teste ficam só no teste e **não conseguem logar** (login é sempre em produção) — documente isso.

### 5.4 Cópia da produção para o teste
- **Primeira ativação** (banco de teste vazio/sem migrations): cria o que faltar, roda as migrations e executa a **cópia completa** (com confirmação na tela). Marque em uma tabela de controle do banco de teste (`teste_copias`: `copiado_em`, `copiado_por`, `contagens JSONB`) quando foi copiado.
- `POST /api/master/modo-teste/copiar-producao` (área `Master`; **somente Master** pode copiar, mesmo que outro usuário tenha `ModoTeste`) com `{ confirmacao: 'COPIAR' }`:
  1. Pré-visualização `GET /api/master/modo-teste/status` com contagens por tabela (produção × teste atual), data da última cópia e se há cópia em andamento.
  2. Trava (advisory lock) para impedir duas cópias simultâneas; durante a cópia, requisições em modo teste recebem 503 "cópia em andamento".
  3. **Leitura** na produção em transação `READ ONLY` com `REPEATABLE READ` (foto consistente); **escrita** só no banco de teste, em **uma transação**: `TRUNCATE` de todas as tabelas de negócio (exceto controle de migrations) `CASCADE` + cópia tabela a tabela **na ordem das chaves estrangeiras**, usando `COPY ... TO/FROM STDIN` em streaming (dependência `pg-copy-streams`) — não carregue tudo em memória. Se algo falhar, `ROLLBACK` e o teste anterior permanece intacto.
  4. Depois da cópia, garanta que o Master/usuário atual exista no teste e registre `teste_copias`.
  5. **Auditoria na produção** (`audit_logs`): quem copiou, quando, contagens. Nunca registrar conteúdo dos dados.
- Nenhuma rota copia do teste para a produção.

### 5.5 Segurança e efeitos externos
- Em modo teste, **desligar efeitos externos**: não enviar e-mail/mensagens (WhatsApp por API, quando existir), não chamar integrações (iFood/99Food futuras). Hoje o envio é por link `wa.me`: no modo teste esconda/desative "Abrir no WhatsApp" ou avise "modo teste".
- **Dados pessoais de clientes reais** foram copiados: o banco de teste deve ter os mesmos cuidados (acesso restrito, sem exportação para fora). Ofereça (opcional, marcado) **"Anonimizar telefones e nomes de clientes ao copiar"**, ligado por padrão na tela de cópia, para o teste não ter dados pessoais reais.
- Cupom e comanda impressos em modo teste levam **"*** TESTE ***"** no topo e no rodapé (`components/Cupom.jsx` e a comanda).
- Auditoria: ligar/desligar o modo teste e copiar da produção ficam registrados em **produção** (`audit_logs`, empresa do usuário). Atividade dentro do teste fica só no `audit_logs` do banco de teste.

### 5.6 Frontend
- **Faixa fixa no topo, em todas as telas**, enquanto `modoTeste` estiver ativo: cor de alerta (usar `--warn`), texto **"MODO TESTE — nada aqui afeta a produção"** e botão **"Voltar à produção"** (chama `POST /api/auth/modo-teste {ativo:false}`, troca o token e recarrega). A faixa não pode ser escondida.
- Botão **"Modo teste"** na conta/menu do usuário, **visível só com a permissão `ModoTeste`** (Master: dentro de `/master`). Ao ligar: confirmação explicando que **esta sessão** passará a usar o banco de teste (as outras sessões seguem em produção); na primeira vez mostra o passo de cópia. **Sem seletor de empresa.**
- Em `/master` > Modo teste: usuário logado, status (última cópia, contagens teste × produção), botão **"Copiar tudo da produção"** (modal de alerta: "isso substitui TODOS os dados de teste", campo para digitar `COPIAR`, opção de anonimizar) e botão ligar/desligar o modo teste da sessão. A faixa "MODO TESTE" mostra "Sessão de teste de <usuário>".
- Estilo: paleta atual (`--bg`, `--panel`, `--gold-light`, `--warn`, `--err`…), tema claro e escuro funcionando; sem gradientes antigos.

## 6. Testes obrigatórios (rodar e mostrar o resultado)

Crie `backend/scripts/e2e-modo-teste.mjs` (no padrão do e2e existente) e rode também manualmente no navegador:

1. Master criado por script **não** aparece em `GET /api/users` e não pode ser criado/editado pela API de usuários (403).
2. Usuário sem `ModoTeste` chamando `POST /api/auth/modo-teste` → 403. Com a permissão concedida nos ajustes do usuário → 200.
3. **Isolamento:** em modo teste, criar venda/pedido/produto/cliente → contagens da **produção inalteradas** (consultar produção por conexão direta ou sessão sem modo teste); a produção recebe nova venda → o teste **não** muda até copiar.
4. Token de teste com permissão retirada depois → requisição seguinte falha e nada é gravado.
5. `DATABASE_URL_TESTE` ausente/igual a `DATABASE_URL` → modo teste indisponível (409), produção intacta.
6. Cópia da produção: antes/depois com contagens iguais; falha no meio (simule) → `ROLLBACK`, teste anterior preservado; apenas Master consegue copiar; auditoria gravada na produção.
7. Usuário comum com `ModoTeste` em modo teste só vê a própria empresa/lojas; o Master em modo teste continua Master (vê `/master`, copia da produção, não acessa dados de empresa); ao voltar para produção, tudo normal.
8. Login, PDV (venda direta), pedidos, clientes e relatórios de um usuário comum continuam funcionando em produção (regressão).
9. Faixa "MODO TESTE" aparece em todas as páginas em modo teste e some ao voltar; cupom/comanda saem com "TESTE".
10. Temas claro e escuro.

## 7. Fora do escopo (não implementar agora)

- Painel Master completo (visão geral do servidor, empresas, usuários globais, backups, auditoria global, configurações globais) — referência futura em `docs/master-preview/preview-master.html`. Regras já validadas nesse preview para quando for implementado: **a criação de empresa cria junto o primeiro administrador** (2 passos: dados da empresa → administrador); **todo usuário é criado dentro de uma empresa** (tela separada "Novo usuário" exige escolher a empresa e as lojas; respeita limite do plano; e-mail único no sistema); e a lista de empresas **não mostra vendas/faturamento** (o Master administra a plataforma, não os dados de negócio dos clientes).
- "Entrar como suporte" em empresas, planos/limites, cobrança.
- Row Level Security / `tenant_id` nas tabelas filhas (melhoria de segurança sugerida à parte).
- Cópia teste → produção; cópia parcial/incremental.

## 8. Ordem sugerida de commits

1. Migration do perfil `Master` + `MATRIX`/`PERMISSOES` (`Master`, `ModoTeste`) + bloqueios em `users.routes`/`Users.jsx`.
2. Script `npm run master`.
3. `DATABASE_URL_TESTE`, trava de segurança, migrations nos dois bancos.
4. `AsyncLocalStorage` no `pool.js` + `authRequired` (contexto de teste) + `POST /api/auth/modo-teste`.
5. Cópia da produção (status, cópia, auditoria, anonimização).
6. Frontend: faixa, botão, `/master` mínimo, cupom/comanda "TESTE".
7. Script e2e e ajustes de tema.

## 9. Entrega

Ao final, rode todos os testes da seção 6 e faça um **relatório em português** com: o que foi feito por commit, decisões tomadas, resultados dos testes (incluindo os que falharam), pendências e qualquer funcionalidade existente que você **não removeu** mas notou conflito. Informe também os comandos para criar o Master (`MASTER_EMAIL=… MASTER_PASSWORD=… MASTER_NOME=… npm run master`) **sem repetir a senha**.

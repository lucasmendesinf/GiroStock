# Prompt — Painel Master, Fase 1/4: Empresas e Usuários (atrelados à empresa)

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Modelo visual **validado pelo cliente**: `docs/master-preview/preview-master.html` (abas **Empresas** e **Usuários & segurança**). Sirva e clique em tudo:
> ```bash
> cd docs/master-preview && npx --yes serve -l 8095 .      # ou: python -m http.server 8095
> ```
> Fases do painel Master: **1 Empresas e Usuários (este)** → 2 Visão geral e Auditoria → 3 Backups e Configurações globais → 4 Entrar como suporte. Faça **somente a Fase 1**.

---

## 1. Objetivo

Transformar a página mínima `/master` em um **painel com abas** e entregar as abas:

1. **Empresas**: lista, ficha, **nova empresa em 2 passos (cria o primeiro administrador junto)**, limites do plano, recursos liberados (Pedidos, Clientes), suspender/reativar. **Sem nenhum dado de venda/faturamento** (o Master administra a plataforma, não os dados de negócio das empresas).
2. **Usuários & segurança**: lista de todos os usuários de todas as empresas, **novo usuário sempre dentro de uma empresa**, forçar troca de senha, encerrar sessões, desativar/reativar, permissão "Modo teste" por usuário, contagem de logins com falha.

As abas **Visão geral, Backups & dados, Auditoria e Configurações globais** entram nas fases seguintes: crie a navegação por abas já com elas listadas como "em breve" (desabilitadas), mantendo a aba **Modo teste** existente funcionando.

Regras de negócio já decididas (não rediscutir):
- **Usuário pertence a uma única empresa** (não compartilha entre empresas) e pode atuar em várias lojas **da mesma empresa**. **Administrador vê todas as lojas da empresa.** E-mail é **único no sistema**. Não altere isso.
- Toda **criação de empresa cria junto o seu primeiro administrador** (telas podem ser separadas, mas o usuário nunca existe sem empresa).
- Listas e fichas do Master **não mostram vendas, faturamento, pedidos nem clientes** das empresas.

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: mantenha e liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador e por requisições reais; build não basta.
- Antes de criar migrations: `ls backend/src/db/migrations` e use o **próximo número livre** (a última conhecida é `017_perfil_master.sql`).
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Nunca** imprima/registre senhas (nem temporárias, exceto a única exibição na criação), tokens ou variáveis de ambiente em log, auditoria ou relatório.
- **Não quebre** login, PDV, pedidos, clientes, relatórios, perfil Master e modo teste. Teste o login de um usuário comum e a página `/master` (Modo teste) depois de cada etapa.
- Estilo: paleta atual (`--bg`, `--panel`, `--gold-light`, `--ok`, `--warn`, `--err`…), temas claro e escuro, sem gradientes antigos.

## 3. Estado atual (leia antes de codar; não refaça o que já existe)

- Já implementado (ver `git log`): perfil **Master** (enum, `MATRIX`, áreas `Master`/`ModoTeste`), empresa "Plataforma", `npm run master`, modo teste com banco separado (`services/modoTeste.js`, `services/copiaProducao.js`), `routes/master.routes.js` (`/api/master/modo-teste/*`, protegido por `requireArea('Master')`), `pages/Master.jsx` (página mínima com Modo teste), faixa "MODO TESTE", teste `scripts/e2e-modo-teste.mjs`.
- `tenants` hoje tem só `id, nome, criado_em` e `clientes_vip_limite`. Não há status, plano, limites nem recursos por empresa.
- `routes/users.routes.js` (área `Configuracoes`): CRUD de usuários **da própria empresa** (já bloqueia o perfil Master). `routes/locations.routes.js`: lojas e terminais (PDVs) da empresa.
- Login (`routes/auth.routes.js`) e permissões usam sempre a produção (`pool.producao`). `middleware/auth.js` recarrega o usuário a cada requisição.
- `logAudit(client, { tenantId, usuarioId, acao, recurso, recursoId, detalhes })` grava em `audit_logs` (`tenant_id` NOT NULL).

## 4. Banco de dados (migration `0NN_master_empresas.sql`)

- `tenants`: `documento TEXT`, `status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','suspensa'))`, `suspenso_motivo TEXT`, `suspenso_em TIMESTAMPTZ`, `plano TEXT NOT NULL DEFAULT 'completo'`, `limites JSONB` (override opcional: `{lojas, usuarios, pdvs}`), `recursos JSONB` (override opcional: `{pedidos, clientes}`).
- Tabela `planos`: `codigo` PK (`basico`, `completo`), `nome`, `max_lojas`, `max_usuarios`, `max_pdvs`, `recursos JSONB`. Seeds: **Básico** (1 loja, 3 usuários, 1 PDV; Pedidos e Clientes **desligados**) e **Completo** (3 lojas, 10 usuários, 4 PDVs; Pedidos e Clientes **ligados**). Limite/recursos **efetivos** da empresa = override da empresa, senão o do plano.
- **Empresas já existentes ficam `plano='completo'`, `status='ativa'`, sem overrides** (nada pode mudar para quem já usa o sistema). A empresa "Plataforma" fica fora de todas as listas e contagens.
- `users`: `ultimo_login TIMESTAMPTZ`, `falhas_login INT NOT NULL DEFAULT 0`, `ultima_falha_em TIMESTAMPTZ`, `deve_trocar_senha BOOLEAN NOT NULL DEFAULT false`, `sessoes_validas_desde TIMESTAMPTZ` (tokens emitidos antes dessa data deixam de valer).

## 5. Back-end

### 5.1 Efeitos nas rotas existentes
- **Login e `authRequired`**: usuário de empresa **suspensa** → 403 "empresa suspensa" (no login e a cada requisição, então sessões abertas caem na hora). O Master nunca é bloqueado.
- **Login**: ao acertar a senha grava `ultimo_login = now()` e zera `falhas_login`; ao errar incrementa `falhas_login` e grava `ultima_falha_em`. Resposta de `login`/`/auth/me` inclui `deveTrocarSenha`; `POST /auth/change-password` limpa o flag. O front **força a troca** antes de liberar o sistema.
- **`authRequired`** recusa token com `iat` anterior a `users.sessoes_validas_desde` (encerrar sessões).
- **Recursos por empresa**: se o recurso efetivo `pedidos`/`clientes` da empresa está desligado, `areas.Pedidos`/`areas.Clientes` ficam **false** para todos os usuários dessa empresa (menu some, rotas respondem 403), mesmo que o perfil permita. Faça isso num ponto só (onde `areasEfetivas` é montada em `authRequired`/login).
- **Limites do plano** (helper em `utils/limites.js`, chamado antes de criar): `POST /users` (usuários ativos da empresa), `POST /locations` (lojas ativas) e `POST /terminals` (PDVs ativos) respondem **409** com mensagem clara ("limite de usuários do plano atingido: 7 de 7") quando excedem.

### 5.2 Rotas `/api/master` (todas `requireArea('Master')`; auditar tudo com `logAudit` usando o `tenant_id` da empresa afetada e `usuario_id` do Master; acões como `master_criar_empresa`, `master_suspender_empresa`, `master_criar_usuario`…)
- `GET /master/empresas` — lista (exceto Plataforma): `id, nome, documento, plano, status, qtd_lojas, qtd_usuarios_ativos, ultimo_acesso (max users.ultimo_login), criado_em`. **Sem vendas/pedidos/clientes.**
- `GET /master/empresas/:id` — ficha: dados, lojas (nome, ativa), **limites efetivos × usados** (lojas, usuários, PDVs), recursos efetivos (e se vêm do plano ou de override), usuários da empresa (nome, e-mail, perfil, ativo, último login).
- `POST /master/empresas` `{ nome, documento?, plano, loja_nome, admin: { nome, email, senha? } }` — **numa transação**: cria `tenants`, a primeira loja e o **usuário Administrador** (sem loja principal = vê todas), com `deve_trocar_senha=true`. Senha: a informada ou **gerada** (10 caracteres legíveis); devolvida **uma única vez** na resposta e nunca registrada. E-mail duplicado no sistema → 409 (e **nada** é criado). Valida limites do plano escolhido.
- `PATCH /master/empresas/:id` — `nome`, `documento`, `plano`, `limites` (override; `null` volta ao plano), `recursos` (override).
- `POST /master/empresas/:id/suspender` `{ motivo }` e `POST /master/empresas/:id/reativar`.
- `GET /master/usuarios?empresa_id&q&situacao` — todos os usuários (exceto Master): empresa, perfil, lojas, último login, `falhas_login`, ativo, se tem `ModoTeste`.
- `POST /master/usuarios` `{ empresa_id (obrigatório), nome, email, perfil, location_id?, location_ids?, senha? }` — **empresa obrigatória** (404 se não existir/for Plataforma); perfil **nunca** Master; lojas devem ser da empresa; Administrador não precisa de loja, os demais perfis exigem ao menos uma; respeita limite de usuários; e-mail único no sistema; `deve_trocar_senha=true`; senha gerada/única exibição como acima. Reaproveite a validação já existente em `users.routes.js` (extraia para função compartilhada em vez de duplicar).
- `POST /master/usuarios/:id/forcar-troca-senha` (marca `deve_trocar_senha`), `POST /master/usuarios/:id/encerrar-sessoes` (`sessoes_validas_desde = now()`), `PATCH /master/usuarios/:id/status` (ativar/desativar; não vale para Master), `PATCH /master/usuarios/:id/permissoes` `{ ModoTeste: true|false }` (use `normalizarOverrides`; só chaves ajustáveis).
- Nada nessas rotas lê ou devolve vendas, pedidos, clientes ou produtos.

## 6. Front-end

Seguir o preview `preview-master.html` (estrutura, textos, estados). Página `/master` com **abas** (rotas `/master/empresas`, `/master/usuarios`, `/master/modo-teste`; as demais "em breve"). Só o Master vê.

- **Empresas**: quadros **Empresas · Ativas · Lojas · Usuários** (sem dinheiro); tabela (Empresa/CNPJ, Lojas, Plano, Situação, Usuários, Último acesso); clique abre a **ficha lateral**: lojas, **limites do plano em barras** (verde/laranja ≥80%/vermelho no limite), **interruptores de recursos** (Pedidos, Clientes), **usuários da empresa** com botão "+ Usuário nesta empresa", Suspender/Reativar (motivo em modal). Botões "Entrar como suporte" e "Exportar dados" aparecem **desabilitados com "em breve"** (Fases 4 e 3). Empresa suspensa mostra o motivo.
- **Nova empresa** (modal em **2 passos**, com indicador): (1) nome, CNPJ, plano, nome da primeira loja; (2) nome do administrador, e-mail, senha temporária (botão "Gerar outra"), opção "Exigir troca de senha no primeiro login" (sempre marcada). Botão final **"Criar empresa e administrador"**. Após criar, mostrar a senha temporária **uma vez** com botão copiar.
- **Usuários & segurança**: quadros (ativos, logins com falha, sem login há 30+ dias); cartão "Perfil Master" explicativo; tabela com **Empresa, Perfil, Último login, Falhas, Modo teste (interruptor), Situação** e ações **Forçar troca de senha · Encerrar sessões · Desativar/Reativar**; botão **"+ Novo usuário"** → modal que **exige escolher a empresa** (lojas listadas só da empresa escolhida; Administrador = todas; mostra "N de M usuários usados" e bloqueia no limite; senha temporária gerável).
- Login: tela de troca obrigatória de senha quando `deveTrocarSenha`.
- Estados de erro/validação claros (e-mail duplicado, limite do plano, empresa suspensa).

## 7. Testes obrigatórios (rodar e mostrar o resultado)

Crie `backend/scripts/e2e-master-fase1.mjs` (padrão do `e2e-modo-teste.mjs`) e teste no navegador:

1. Criar empresa pela API cria **empresa + loja + administrador** juntos; e-mail duplicado → 409 e **nada** criado; o administrador entra, é forçado a trocar a senha e vê todas as lojas.
2. **Isolamento**: usuário/administrador de uma empresa **não** vê a nova empresa nem seus usuários; as rotas `/api/master/*` respondem 403 para quem não é Master.
3. Suspender → usuários da empresa recebem 403 no login e na **próxima requisição de uma sessão já aberta**; reativar → voltam; Master nunca é afetado.
4. Plano Básico: Pedidos/Clientes **indisponíveis** (menu some, rotas 403) mesmo para Administrador; ligar o recurso por override libera; desligar bloqueia de novo. Empresas antigas continuam com tudo liberado.
5. Limites: criar usuário/loja/PDV além do plano → 409 em **ambos** os caminhos (rota da empresa e rota Master).
6. `POST /master/usuarios` sem `empresa_id` → 400; com perfil Master → 403; loja de outra empresa → 4xx.
7. Forçar troca de senha, encerrar sessões (token antigo deixa de valer; novo login funciona), desativar/reativar, permissão `ModoTeste` por usuário (concede/retira).
8. Contagem de falhas de login incrementa e zera no login correto.
9. Nenhuma resposta `/api/master/empresas*` contém vendas, pedidos, clientes ou produtos.
10. Regressão: login comum, PDV (venda direta), pedidos, clientes, modo teste e `npm run test:e2e:modo-teste` continuam passando. Temas claro e escuro nas telas novas.

## 8. Fora do escopo (próximas fases)

Visão geral/saúde do servidor, auditoria global, backups, exportação de dados, configurações globais (planos editáveis, avisos, manutenção), "Entrar como suporte". **Não implemente agora.** Os botões correspondentes ficam desabilitados com "em breve".

## 9. Ordem sugerida de commits

1. Migration + planos + helpers de limites/recursos. 2. Efeitos nas rotas existentes (suspensão, recursos, limites, `ultimo_login`/falhas, troca obrigatória, sessões). 3. Rotas Master de empresas. 4. Rotas Master de usuários. 5. Front: abas, Empresas, nova empresa. 6. Front: Usuários & segurança, troca de senha obrigatória. 7. Script e2e e ajustes de tema.

## 10. Entrega

Rode todos os testes da seção 7 e faça um **relatório em português**: o que foi feito por commit, decisões tomadas, resultados (inclusive falhas), pendências e qualquer funcionalidade existente que você **não removeu** mas notou conflito. Não repita senhas nem chaves no relatório.

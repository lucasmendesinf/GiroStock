# Prompt — Painel Master, Fase 3/4: Backups e dados + Configurações globais

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Modelo visual **validado**: `docs/master-preview/preview-master.html` (abas **Backups & dados** e **Configurações globais**). Sirva e clique em tudo:
> ```bash
> cd docs/master-preview && npx --yes serve -l 8095 .      # ou: python -m http.server 8095
> ```
> **Pré-requisito: Fases 1 e 2 concluídas** (confira `git log`, `ls frontend/src/pages`, `routes/master.routes.js`). Se faltar alguma, **pare e avise**. Faça **somente a Fase 3**.

---

## 1. Objetivo

1. **Backups & dados**: gerar backup do banco de produção (manual e **automático diário**), listar, baixar, **restaurar de forma segura**, exportar os dados de uma empresa, manutenção segura.
2. **Configurações globais**: status das integrações (sem mostrar chaves), **aviso global** para todos os usuários, **modo manutenção**, **parâmetros padrão** e edição dos **planos** (criados na Fase 1).

Decisões já tomadas (não rediscutir):
- **Restaurar pela tela vai SEMPRE para o banco de teste** (seguro: não toca na produção). **Restaurar na produção só por script no servidor** (`npm run restaurar-backup`, com confirmações), nunca por botão.
- **Honestidade:** só implemente o que o sistema consegue fazer. O preview tem "Reprocessar tarefas com falha" e "Impressora/e-mail" que **não existem** (não há fila de tarefas nem e-mail): **omita**. Integrações iFood/99Food/WhatsApp API aparecem como "não configurado/etapa futura".
- Segredos (senhas, chaves, tokens, `DATABASE_URL*`) **nunca** aparecem em tela, API, log ou auditoria — só status "configurado / não configurado".
- O Master administra a plataforma: exportações e telas **não** exibem dados de venda de forma analítica; a exportação por empresa existe para **LGPD e migração** e é auditada.

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador e por requisições reais; build não basta.
- Antes de criar migrations: `ls backend/src/db/migrations` e use o **próximo número livre**.
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Nunca** imprima/registre senhas, tokens, segredos ou `hash` de senha/segredos TOTP (se existirem) em arquivos exportados, logs ou relatório.
- **Não quebre** login, PDV, pedidos, clientes, relatórios, Master (Fases 1–2), modo teste.
- Estilo: paleta atual, temas claro e escuro, sem gradientes antigos.

## 3. Estado atual (leia antes; confirme no código)

- `services/copiaProducao.js` já faz **COPY em streaming**, lê a produção em transação `READ ONLY`/`REPEATABLE READ`, ordena tabelas pelas chaves estrangeiras e escreve no banco de teste em uma transação (reaproveite helpers, **não duplique**). `services/modoTeste.js` tem os pools produção/teste e as travas de segurança.
- `tenants.clientes_vip_limite` (por empresa) e constantes fixas no código: segmentos de clientes **em risco = 30–59 dias e inativo ≥ 60** (`routes/customers.routes.js`) e **pedido atrasado após 25 min** (`frontend/src/pages/Pedidos.jsx`, constante `ATRASO_MIN`). Procure por outras constantes com `grep`.
- Tabela `planos` e `tenants.plano/limites/recursos` (Fase 1). `logAudit` para auditoria. Não existe agendador interno, nem pasta de backups, nem tabela de configuração global.
- A hospedagem pode ser **cPanel com Node 14 e sem `pg_dump`**, ou Docker com Node 20. O código deve funcionar nos dois (ver 5.1).

## 4. Banco de dados (migration `0NN_master_backups_config.sql`)

- `backups`: `id`, `arquivo` (nome, sem caminho), `tamanho_bytes`, `sha256`, `tipo` (`automatico|manual`), `status` (`gerando|concluido|falhou`), `erro` (texto curto), `criado_por` (usuário, nulo no automático), `criado_em`, `versao_schema` (última migration aplicada).
- `config_global`: `chave TEXT PRIMARY KEY`, `valor JSONB`, `atualizado_em`, `atualizado_por`. Chaves iniciais (com padrão no código se ausentes): `vip_limite_padrao` (400), `cliente_risco_dias` (30), `cliente_inativo_dias` (60), `pedido_atrasado_min` (25), `backup_retencao_dias` (30), `backup_hora` ("03:00"), `backup_automatico` (true), `manutencao` (`{ativo:false, mensagem:""}`).
- `avisos_globais`: `id`, `mensagem`, `ativo`, `criado_por`, `criado_em`, `removido_em` (apenas **um** aviso ativo por vez).

## 5. Back-end

### 5.1 Backups (`/api/master/backups*`, `requireArea('Master')`)
- Diretório por variável **`BACKUP_DIR`** (padrão `backend/backups`, **fora** de qualquer pasta servida e no `.gitignore`). Valide gravação na inicialização; se indisponível, a aba mostra o erro e **nada quebra**.
- **Gerar** (`POST /master/backups`): cria registro `gerando`, executa e marca `concluido/falhou`; uma geração por vez (advisory lock). Estratégia em duas camadas:
  1. se `pg_dump` estiver disponível (detecte com `pg_dump --version`), use-o em formato customizado/comprimido com `DATABASE_URL` passada por **variável de ambiente do processo filho** (nunca na linha de comando);
  2. senão, **dump em JavaScript** reaproveitando o streaming de `copiaProducao.js`: arquivo `.gz` com cabeçalho (versão do schema, data) + dados de cada tabela via `COPY ... TO STDOUT`, na mesma ordem de FKs, lido em `READ ONLY`/`REPEATABLE READ`.
  Calcule `sha256` e tamanho. **Não** inclua `schema_migrations`/tabelas de controle do modo teste de forma que quebre a restauração (documente o formato).
- **Listar** (`GET`), **baixar** (`GET /master/backups/:id/download`, autenticado, em streaming, com `Content-Disposition`; conferir `sha256` antes), **remover** (somente do disco+registro, só Master, auditado).
- **Rotina automática diária**: agendador **dentro do processo** (sem dependência nova): verifica a cada minuto se chegou `backup_hora` e se ainda não houve backup automático no dia; usa advisory lock para não rodar em duas instâncias; respeita `backup_automatico`. **Retenção**: apaga backups automáticos mais antigos que `backup_retencao_dias` (nunca os manuais). Falha → registro `falhou` + auditoria; a rotina tenta de novo só no dia seguinte.
- **Restaurar no banco de teste** (`POST /master/backups/:id/restaurar-teste` `{ confirmacao: 'RESTAURAR' }`): substitui o banco de teste pelo conteúdo do backup (transação única; falha → `ROLLBACK`, teste anterior preservado), exige banco de teste configurado e **diferente** da produção (reaproveite as travas de `modoTeste.js`), responde 503 para sessões em modo teste durante a operação. Auditoria.
- **Restaurar na produção**: **somente** `backend/scripts/restaurar-backup.js` + `npm run restaurar-backup` (`BACKUP_ARQUIVO=...`): exige confirmação digitada no terminal, mostra a data do backup e quantos registros serão **perdidos**, cria **automaticamente um backup de segurança antes**, coloca o sistema em modo manutenção durante a operação e registra auditoria. Documente o procedimento no deploy. **A UI só explica** isso ("para restaurar na produção, use o procedimento no servidor") — sem botão.
- **Exportar dados de uma empresa** (`POST /master/empresas/:id/exportar` → arquivo `.json.gz` gerado em `BACKUP_DIR/exportacoes`, `GET` para baixar): todas as tabelas com `tenant_id` dessa empresa (e filhas via vínculo: itens de pedido, endereços de cliente etc.), um bloco por tabela. **Exclua** `senha_hash`, segredos TOTP, códigos de recuperação e tokens. Auditoria `master_exportar_empresa`. Habilite o botão "Exportar dados" que estava "em breve" na ficha da empresa (Fase 1).
- **Manutenção segura**: (a) **Verificar saldos de estoque**: compara `stock_balances` com a soma de `stock_movements` (e insumos) e **só relata divergências** por empresa/produto; opção **"Corrigir divergências"** separada, com confirmação, que registra movimento de ajuste auditado (não sobrescreve silenciosamente); (b) **Otimizar banco** (`ANALYZE` — evite `VACUUM FULL`/`REINDEX` bloqueantes) com aviso de duração. **Não** crie "reprocessar tarefas" (não existe fila).

### 5.2 Configurações globais (`/api/master/config*`, `requireArea('Master')`)
- `GET /master/config/integracoes`: lista de status calculado do ambiente (**sem valores**): banco de teste configurado/ok, e-mail SMTP (**não configurado** se não houver), WhatsApp API (**não contratado; usa link wa.me**), iFood e 99Food (**etapa futura**), `BACKUP_DIR` gravável, `TOTP_ENC_KEY` presente (se existir a funcionalidade). Botão "Testar" só onde houver teste real (banco; gravação em `BACKUP_DIR`).
- **Aviso global**: `GET/POST /master/avisos` (publicar substitui o ativo) e `DELETE` (remover). Exposição para todos os usuários logados via `GET /auth/me` (campo `avisoGlobal`) **ou** rota leve `GET /api/aviso-global` (decida e documente). Front: **faixa fixa discreta** no topo para todos os usuários (dispensável pelo usuário até o próximo aviso; guardar a dispensa em `localStorage` por id do aviso). Auditoria.
- **Modo manutenção**: `PUT /master/config/manutencao` `{ ativo, mensagem }`. Com `ativo`, **toda** rota (exceto `/api/auth/login` para o Master, `/api/auth/me` e `/api/master/*` do Master) responde **503** com a mensagem; o front mostra uma tela de manutenção. O Master continua entrando e usando o painel. Auditoria. Cuidado para não bloquear o próprio Master por engano (teste isso).
- **Parâmetros padrão**: `GET/PUT /master/config/parametros` (validação de faixas: dias ≥ 1, minutos ≥ 1, retenção 1–365, valor VIP ≥ 0). **Faça o sistema usar esses valores**: substitua as constantes de `customers.routes.js` (risco/inativo) e do `ATRASO_MIN` do front (entregue pelo backend, ex.: em `/auth/me` ou `/pedidos`) por leitura de `config_global` com fallback aos valores atuais; `vip_limite_padrao` é o **valor inicial** para empresas novas (cada empresa mantém o seu `clientes_vip_limite`). Cache em memória com invalidação ao salvar. Nenhum comportamento muda enquanto os valores estiverem nos padrões.
- **Planos**: `GET/PUT /master/planos/:codigo` (nome, max_lojas, max_usuarios, max_pdvs, recursos). A mudança vale para empresas **sem override** (Fase 1) e **não** derruba quem já excede o limite (apenas impede novos cadastros) — mostre aviso "N empresas já excedem o novo limite".

## 6. Front-end (seguir o preview)

- **Backups & dados**: cartões (último backup, rotina automática com hora, espaço usado), botão **"Gerar backup agora"** com barra de progresso/estado real (consulta o registro), tabela (Data, Tipo, Tamanho, Situação, ações **Baixar · Restaurar no teste · Remover**), modal de restauração no teste com alerta e campo **RESTAURAR**, bloco "**Restaurar na produção**" explicando o procedimento por script, bloco **Dados por empresa → Exportar dados** (gera e oferece o download), bloco **Manutenção** (Verificar saldos, Corrigir divergências, Otimizar banco).
- **Configurações globais**: Integrações (status), **Aviso para todos os usuários** (campo + Publicar/Remover + prévia), **Modo manutenção** (interruptor + mensagem; aviso claro de que bloqueia as empresas), **Parâmetros padrão** (formulário), **Planos** (editar limites/recursos, avisando as empresas afetadas).
- Faixa de aviso global e tela de manutenção para os demais usuários; atalhos "Gerar backup" e "Aviso" da Visão geral (Fase 2) passam a funcionar.
- Textos em português; estados vazios e de erro tratados; temas claro e escuro.

## 7. Testes obrigatórios

Crie `backend/scripts/e2e-master-fase3.mjs` e teste no navegador:

1. Gerar backup manual (com e sem `pg_dump` disponível, simulando a ausência) → registro `concluido`, `sha256` confere, download idêntico; falha simulada → `falhou` sem arquivo parcial.
2. **Restaurar no teste**: produção alterada depois do backup → restaurar no teste → contagens do **teste** = as do backup e **produção intacta**; falha no meio → teste anterior preservado; sem confirmação → 400; banco de teste igual ao de produção → recusado.
3. `npm run restaurar-backup`: exige confirmação, faz **backup de segurança antes**, restaura, coloca/tira o modo manutenção; teste em um banco descartável (**nunca** na base de desenvolvimento em uso sem backup).
4. Rotina automática: com a hora simulada, gera **uma** vez por dia mesmo com duas instâncias; retenção apaga só **automáticos** antigos.
5. Exportar empresa A: arquivo contém **só** dados da empresa A (nenhuma linha de B), **sem** `senha_hash`/segredos; auditado.
6. Verificar saldos: relata divergências (crie uma artificial no banco de **teste**) sem alterar nada; "Corrigir" gera movimento de ajuste auditado.
7. Aviso global aparece para usuários de **qualquer** empresa, some ao remover, dispensa por usuário funciona.
8. Modo manutenção: usuários comuns recebem 503 + tela; o **Master continua operando**; ao desligar tudo volta.
9. Parâmetros: alterar `cliente_risco_dias`/`pedido_atrasado_min` muda o comportamento real (segmentos de clientes e faixa de atraso nos pedidos); valores padrão não mudam nada; validação de faixas.
10. Planos: editar limite vale para empresas sem override; empresas acima do limite continuam funcionando.
11. Segredos: nenhuma resposta/log/arquivo contém senhas, tokens, `DATABASE_URL`.
12. Regressão: Fases 1–2, login, PDV, pedidos, clientes, modo teste e `npm run test:e2e:modo-teste`. Temas claro e escuro.

## 8. Fora do escopo

"Entrar como suporte" (Fase 4), restauração de produção por botão, envio de backup para nuvem/e-mail, fila de tarefas/impressão, integrações reais (iFood/99Food/WhatsApp API), relatórios de vendas do Master.

## 9. Ordem sugerida de commits

1. Migration + `config_global` + leitura de parâmetros (com fallback) usada por clientes/pedidos. 2. Geração de backup (pg_dump + fallback JS), listagem, download. 3. Agendador diário e retenção. 4. Restaurar no teste. 5. Script `restaurar-backup`. 6. Exportar dados por empresa. 7. Manutenção (saldos, otimizar). 8. Aviso global e modo manutenção. 9. Planos e integrações. 10. Front: Backups & dados. 11. Front: Configurações globais, faixa de aviso, tela de manutenção. 12. e2e e temas.

## 10. Entrega

Rode os testes da seção 7 e faça um **relatório em português**: o que foi feito por commit, decisões (formato do backup, `pg_dump` x JS, limiares), resultados (inclusive falhas e o que ficou pendente de teste manual), como configurar `BACKUP_DIR` e o procedimento de restauração na produção, pendências e funcionalidades existentes que você **não removeu** mas notou conflito. Não repita segredos.

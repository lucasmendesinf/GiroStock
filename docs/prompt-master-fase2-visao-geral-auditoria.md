# Prompt — Painel Master, Fase 2/4: Visão geral do sistema e Auditoria global

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Modelo visual **validado**: `docs/master-preview/preview-master.html` (abas **Visão geral** e **Auditoria**). Sirva e clique em tudo:
> ```bash
> cd docs/master-preview && npx --yes serve -l 8095 .      # ou: python -m http.server 8095
> ```
> **Pré-requisito: Fase 1 concluída** (abas, empresas, usuários, `ultimo_login`, `falhas_login`). Confira com `git log` e `ls frontend/src/pages`; se a Fase 1 não estiver no repositório, **pare e avise**. Faça **somente a Fase 2**.

---

## 1. Objetivo

1. **Visão geral do sistema** (aba inicial do painel Master): saúde da API e do banco, recursos do servidor, uso da plataforma, erros nas últimas 24 h e últimos erros, ações rápidas.
2. **Auditoria geral**: lista unificada, filtrável e exportável de tudo o que ficou registrado em `audit_logs` (de todas as empresas) — incluindo ações do próprio Master.

Regras decididas (não rediscutir):
- O Master administra a **plataforma**: **nenhuma tela mostra vendas, faturamento, pedidos ou clientes** das empresas (nem em "uso de hoje").
- **Honestidade nos indicadores:** só mostre o que o sistema **realmente consegue medir**. O preview tem cards (fila de impressão, e-mail/mensagens) que **não existem** no sistema real: **não** invente dados — omita-os ou mostre "não monitorado". Disco/CPU/memória podem não estar disponíveis (hospedagem compartilhada/Node antigo): mostre "indisponível" sem quebrar.
- A auditoria **não pode ser apagada nem editada** por nenhuma rota.

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador e por requisições reais; build não basta.
- Antes de criar migrations: `ls backend/src/db/migrations` e use o **próximo número livre**.
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Nunca** imprima/registre senhas, tokens, segredos ou variáveis de ambiente (nem na auditoria, nem nos erros capturados).
- **Não quebre** login, PDV, pedidos, clientes, relatórios, Master, modo teste. O que entrar no caminho de **toda requisição** (contadores, captura de erro, "último acesso") deve ser **barato** e nunca derrubar a requisição se falhar.
- Estilo: paleta atual, temas claro e escuro, sem gradientes antigos.

## 3. Estado atual (leia antes; confirme no código)

- Painel Master com abas (Fase 1); `routes/master.routes.js` com `requireArea('Master')`.
- `logAudit(...)` em `utils/audit.js` grava em `audit_logs (tenant_id NOT NULL, usuario_id, acao, recurso, recurso_id, detalhes JSONB, criado_em)`. **Liste os valores de `acao` realmente usados**: `grep -rn "acao:" backend/src` — a auditoria global deve mapear **o que existe** para tipos de filtro (ex.: `venda`, `cancelamento`, `pedido`, `seguranca`, `config`, `suporte`, `suspensao`, `backup`, `login_falha`), sem inventar.
- `app.js` registra as rotas; há um middleware de erro (confira onde as respostas 5xx são produzidas).
- `users.ultimo_login`, `falhas_login` existem (Fase 1). **Não existe** "último acesso" por requisição, captura de erros, contador de requisições nem checagem de saúde.

## 4. Banco de dados (migration `0NN_master_monitoramento.sql`)

- `erros_sistema`: `id`, `criado_em`, `metodo`, `rota` (padrão da rota, **sem** query string nem ids soltos quando possível), `status INT`, `mensagem TEXT` (truncada, **sem dados pessoais/segredos**), `tenant_id` (nulo se desconhecido), `usuario_id`. Índice por `criado_em`. **Retenção de 30 dias** (limpeza diária).
- `users.ultimo_acesso TIMESTAMPTZ` (atualizado no `authRequired` **no máximo 1 vez por minuto por usuário**, sem bloquear a requisição) — usado para "usuários online agora" (janela de 5 min).
- Índice em `audit_logs (criado_em)` (a existente é por tenant/recurso) para a listagem global.

## 5. Back-end (`/api/master`, tudo `requireArea('Master')`)

- **Captura de erros**: no middleware de erro, gravar em `erros_sistema` os **5xx** (e opcionalmente 409/500 de negócio que forem relevantes — decida e documente); falha ao gravar o erro **não** pode causar novo erro.
- **Contador de requisições/min**: anel em memória (últimos 60 minutos, um balde por minuto) incrementado por middleware leve; "pico" = maior balde. Aceite que reinício do processo zera (documente).
- `GET /master/saude`:
  - **API**: `online`, `uptime` (`process.uptime()`), versão (de `package.json`; commit curto se disponível por variável de ambiente, senão omita).
  - **Banco de produção**: latência de um `SELECT 1`, versão do PostgreSQL, **migrations aplicadas × arquivos existentes** (alerta se faltar alguma), tamanho do banco (`pg_database_size`); mesma checagem resumida para o **banco de teste** se estiver configurado.
  - **Recursos do servidor**: memória do processo e do sistema (`os`), carga (`os.loadavg()`; no Windows pode ser 0 → "indisponível"), **disco** (`fs.statfs` só existe em Node ≥ 18.15 — detecte a função; senão "indisponível"). Nunca lance erro por indisponibilidade.
  - Cada bloco com `status`: `ok | atencao | erro | indisponivel`, e limiares simples e documentados (ex.: memória > 85% = atenção; disco > 85% = atenção; migration pendente = erro).
- `GET /master/uso`: empresas ativas hoje (≥ 1 login hoje), usuários online agora, usuários cadastrados, lojas ativas, requisições/min (pico dos últimos 60 min). **Sem vendas/pedidos.**
- `GET /master/erros?horas=24` — contagem **por hora** das últimas 24 h + os **últimos 20 erros** (hora, método+rota, status, mensagem, empresa).
- `GET /master/auditoria?tipo&empresa_id&usuario_id&de&ate&q&pagina` — paginada (50/página), mais recentes primeiro, com **nome da empresa e do usuário** (join), `tipo` mapeado da `acao`, `detalhes` já **saneado** (remova campos sensíveis se houver). `GET /master/auditoria/exportar` → CSV (mesmos filtros, limite razoável, cabeçalhos em português).
- Garanta que **não existe** nenhuma rota de edição/exclusão em `audit_logs` (e escreva um teste que tenta e falha).
- **Login com falha** na auditoria: registre `acao: 'login_falha'` (tenant do usuário se o e-mail existir; senão empresa "Plataforma"), **sem a senha tentada**; para não gerar ruído, registre a partir da **3ª falha seguida** do mesmo usuário e depois a cada 5ª.
- Ações do painel Master das fases anteriores já auditam; confira que aparecem na lista com o tipo certo.

## 6. Front-end (seguir o preview)

- **Visão geral** (aba inicial): cards de estado (API, Banco; **omita** impressão e e-mail ou mostre "não monitorado"), bloco **Recursos do servidor** (barras; "indisponível" quando for o caso), **Uso hoje (plataforma)** (empresas ativas, usuários online, usuários cadastrados, lojas ativas, requisições/min pico), **Erros nas últimas 24 h** (contador + gráfico de barras por hora, barras vermelhas acima do limiar), tabela **Últimos erros**, **Ações rápidas** (atalhos para Modo teste e, quando existirem, Backups/Aviso — desabilitados "em breve" até a Fase 3), botão "verificar de novo", atualização automática a cada 30–60 s sem piscar. Nota de rodapé explicando por que disco/CPU podem faltar em hospedagem compartilhada.
- **Auditoria**: filtros (tipo, empresa, usuário, período, busca), tabela (Quando, Quem, Empresa, Tipo, Detalhe), paginação, botão **Exportar CSV**, nota de que o registro **não pode ser apagado**.
- Textos em português, estados vazios e de erro tratados, temas claro/escuro.

## 7. Testes obrigatórios

Crie `backend/scripts/e2e-master-fase2.mjs` e teste no navegador:

1. Só Master acessa `/api/master/saude|uso|erros|auditoria*` (demais perfis 403).
2. Forçar um erro 5xx de teste (ex.: rota inexistente protegida por flag de teste ou consulta inválida em ambiente de teste — **sem deixar código de teste em produção**) aparece em `/master/erros` com contagem por hora e sem dados sensíveis na mensagem.
3. `ultimo_acesso` atualiza no máximo 1×/min e "usuários online" reflete a janela de 5 min.
4. Saúde: com migration pendente simulada (no banco de **teste**) o status vira erro; sem `fs.statfs` o disco vira "indisponível" sem exceção.
5. Auditoria: ações reais geradas pelo teste (login com falha repetido, criar empresa, suspender) aparecem com tipo/empresa/usuário corretos; filtros e paginação funcionam; CSV bate com a lista e **não contém senhas/segredos**.
6. Não existe forma de apagar/editar `audit_logs` pela API.
7. Nada de vendas/pedidos/clientes nas respostas.
8. Regressão: login, PDV, pedidos, clientes, modo teste, Fases anteriores e `npm run test:e2e:modo-teste` passando; o middleware de métricas não aumenta perceptivelmente a latência (compare antes/depois em uma rota simples).
9. Temas claro e escuro.

## 8. Fora do escopo

Backups, exportação de dados por empresa, configurações globais (avisos, manutenção, planos, parâmetros), "Entrar como suporte", alertas por e-mail/WhatsApp, fila de impressão/e-mail (não existem no sistema).

## 9. Ordem sugerida de commits

1. Migration + captura de erros + contador + `ultimo_acesso`. 2. `/master/saude` e `/master/uso`. 3. `/master/erros`. 4. Auditoria global (+CSV, `login_falha`). 5. Front: Visão geral. 6. Front: Auditoria. 7. e2e e ajustes de tema.

## 10. Entrega

Rode os testes da seção 7 e faça um **relatório em português**: o que foi feito por commit, decisões (limiares, o que foi omitido por não existir), resultados (inclusive falhas), pendências e funcionalidades existentes que você **não removeu** mas notou conflito.

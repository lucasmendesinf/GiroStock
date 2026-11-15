# Prompt — Painel Master, Fase 4/4: Entrar como suporte

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Modelo visual **validado**: `docs/master-preview/preview-master.html` (botão **Entrar como suporte** na lista/ficha de Empresas e janela de motivo). Sirva e veja:
> ```bash
> cd docs/master-preview && npx --yes serve -l 8095 .      # ou: python -m http.server 8095
> ```
> **Pré-requisito: Fases 1, 2 e 3 concluídas** (confira `git log`). A Fase 2 (auditoria global) é obrigatória aqui. Se faltar alguma, **pare e avise**. Faça **somente a Fase 4**.

---

## 1. Objetivo

Permitir que o **Master** acesse o sistema **como o administrador de uma empresa**, para suporte, de forma **controlada, temporária e totalmente auditada**:

- exige **motivo** (obrigatório);
- sessão de **30 minutos**, **sem renovação**, **somente leitura por padrão** (edição só se o Master marcar "Permitir edição");
- **faixa fixa** em todas as telas mostrando que é suporte, a empresa, o tempo restante e o botão **"Encerrar suporte"**;
- **aviso dentro do sistema** para os administradores da empresa (opção marcada por padrão);
- **histórico de acessos de suporte** na ficha da empresa e na auditoria global.

Decisões já tomadas (não rediscutir):
- Durante o suporte, o Master age com o **perfil efetivo Administrador da empresa** (todas as lojas, áreas de Administrador), **mas a identidade registrada em toda auditoria continua sendo a do Master** (nunca se passa pelo administrador real).
- **Modo teste e suporte são exclusivos** (não pode ter os dois ativos na mesma sessão).
- **Ações sensíveis são bloqueadas mesmo com edição liberada** (ver 5.3).
- Só empresas **ativas** (não suspensas) podem receber suporte.

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador e por requisições reais; build não basta.
- Antes de criar migrations: `ls backend/src/db/migrations` e use o **próximo número livre**.
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Nunca** imprima/registre senhas, tokens, segredos ou o JWT de suporte em log/auditoria/relatório.
- **Segurança em primeiro lugar:** esta fase dá ao Master acesso a dados de empresas (inclusive dados pessoais de clientes). Na dúvida, restrinja. **Não quebre** login, PDV, pedidos, clientes, Master (Fases 1–3), modo teste.
- Estilo: paleta atual, temas claro e escuro, sem gradientes antigos.

## 3. Estado atual (leia antes; confirme no código)

- `middleware/auth.js` (`authRequired`): valida JWT, recarrega o usuário da **produção**, aplica contexto de **modo teste** (claim `modo`), recusa tokens antigos (`sessoes_validas_desde`), bloqueia empresa suspensa, aplica recursos/áreas por empresa (Fase 1). O Master em produção tem áreas de empresa **false**; em modo teste o Master vira Administrador de uma empresa **do banco de teste** (claim `empresaTeste`) — **use esse mesmo mecanismo como referência** para "perfil efetivo Administrador de outra empresa", mas em **produção** e com as restrições desta fase.
- `POST /auth/modo-teste` emite novo JWT; `AuthContext.alternarModoTeste` troca o token no front; faixa "MODO TESTE" existe (reaproveite o padrão visual para a faixa de suporte, com cor/texto distintos).
- Auditoria global (Fase 2) lista `audit_logs` com tipo `suporte` (mapeie as novas ações para ele).
- Ficha da empresa (Fase 1) tem os botões "Entrar como suporte" (desabilitado "em breve") — habilite-o aqui.

## 4. Banco de dados (migration `0NN_suporte.sql`)

- `sessoes_suporte`: `id`, `master_id` (users), `tenant_id` (empresa acessada), `motivo TEXT NOT NULL`, `edicao BOOLEAN NOT NULL DEFAULT false`, `avisou_admins BOOLEAN`, `iniciada_em`, `expira_em`, `encerrada_em`, `encerrada_por` (`master|expirou|sistema`), `ip` (opcional). Índices por `tenant_id` e `master_id`.
- `avisos_empresa`: `id`, `tenant_id`, `tipo` (`suporte`), `mensagem`, `sessao_suporte_id`, `criado_em`, `lido_por JSONB` (ids de usuários que dispensaram) ou tabela filha `avisos_empresa_lidos`. Mostrados aos **administradores** da empresa.

## 5. Back-end

### 5.1 Iniciar e encerrar
- `POST /master/empresas/:id/suporte` `{ motivo, edicao: boolean, avisar: boolean }` (`requireArea('Master')`):
  - `motivo` obrigatório (mínimo 10 caracteres, máximo 300); empresa precisa existir, estar **ativa** e não ser a Plataforma; sessão do Master **não** pode estar em modo teste nem ter outra sessão de suporte aberta (409).
  - Cria `sessoes_suporte` (`expira_em = now() + 30 min`) e devolve um **novo JWT** com claim `suporte: { sessaoId, tenantId }` e `exp` de **no máximo 30 minutos** (nunca renovável: não há refresh).
  - Se `avisar`, cria `avisos_empresa` para os administradores da empresa: "A equipe de suporte da plataforma acessou sua conta em dd/mm hh:mm. Motivo: …" (inclua o motivo; **não** o nome pessoal do Master, só "equipe de suporte").
  - Auditoria `master_suporte_iniciar` (empresa, motivo, edição, sessaoId).
- `POST /master/suporte/encerrar`: marca `encerrada_em`/`encerrada_por='master'`, devolve novo JWT de **Master puro**, auditoria `master_suporte_encerrar`. Expiração: `authRequired` verifica `expira_em` e `encerrada_em` **a cada requisição** (o JWT sozinho não basta) e responde 401 "sessão de suporte encerrada" quando vencida; um job/verificação marca `encerrada_por='expirou'`.
- Mudar a senha do Master, desativar o Master ou `sessoes_validas_desde` invalida a sessão de suporte também.

### 5.2 Perfil efetivo durante o suporte (`authRequired`)
- Com a claim `suporte` válida: `req.user.tenantId` = empresa acessada; `perfil` efetivo = **Administrador** (todas as lojas); `areas` de Administrador **respeitando** recursos/limites/suspensão da empresa; `req.user.id` e a identidade de auditoria continuam sendo a do **Master** (`req.user.master = true`, `req.user.suporte = { sessaoId, edicao, expiraEm }`).
- Todo `logAudit` feito durante uma sessão de suporte deve **acrescentar** em `detalhes`: `{ suporte: true, sessao_suporte_id, master_id }` (ajuste `utils/audit.js` num ponto só, em vez de editar cada rota).
- **Modo teste e suporte exclusivos**: `POST /auth/modo-teste` recusa quando há suporte ativo e vice-versa.

### 5.3 Restrições da sessão de suporte (middleware logo após `authRequired`)
- **Somente leitura por padrão**: qualquer método diferente de `GET/HEAD/OPTIONS` responde **403** "sessão de suporte somente leitura", exceto `POST /master/suporte/encerrar` e `GET /auth/me`.
- **Mesmo com edição liberada, bloqueie sempre** (403): criar/editar/desativar **usuários**, trocar/redefinir **senhas**, **resetar 2FA**, alterar permissões, suspender/alterar plano, exportar dados, gerar/baixar/restaurar backups, qualquer rota `/api/master/*` (exceto encerrar), e **cancelamento de vendas** (estorna estoque e caixa). Permita apenas a correção de cadastros (produtos, fornecedores, lojas, PDVs, estoque e configuração de cupom); se achar necessário bloquear mais algo, documente no relatório. Mantenha a lista num único arquivo de configuração fácil de revisar.
- Dados pessoais: o suporte vê clientes/pedidos **porque a empresa o autorizou ao aceitar o aviso/termos**; **registre a leitura** de listas sensíveis? Não registre cada GET; registre **o início/fim**, o motivo e **todas as escritas**.
- Se a Fase de **2FA** (`docs/prompt-implementar-2fa.md`) já estiver implementada, **exigir um código TOTP recente** do Master para iniciar o suporte (reautenticação). Se não estiver, deixe o ponto de extensão e registre no relatório.

### 5.4 Consulta
- `GET /master/empresas/:id/suporte` — histórico de sessões da empresa (quem [Master], motivo, edição, início, fim, como encerrou).
- Avisos: `GET /avisos-empresa` (administradores da empresa; os não lidos) e `POST /avisos-empresa/:id/dispensar`.
- Auditoria global (Fase 2): filtro por tipo `suporte` passa a listar início/fim e as escritas feitas durante o suporte (marcadas).

## 6. Front-end

- **Ficha/lista de Empresas**: habilitar **"Entrar como suporte"** (só empresas ativas). Modal igual ao preview: **motivo obrigatório**, interruptor "Avisar o administrador da empresa" (padrão ligado), interruptor "Permitir edição durante o suporte" (padrão desligado), texto explicando "sessão de 30 minutos, somente leitura a menos que você libere edição, tudo fica registrado". Botão **Entrar**.
- Ao entrar: trocar o token (como o modo teste faz), recarregar `/auth/me` e **abrir o sistema da empresa** (a tela normal do Administrador). **Faixa fixa em todas as telas** (cor distinta da faixa de modo teste; não pode ser escondida): "SUPORTE — acessando <empresa> como administrador · somente leitura/edição liberada · expira em MM:SS" + botão **Encerrar suporte**. Contagem regressiva real; ao expirar, voltar automaticamente ao painel Master com mensagem.
- Telas que seriam bloqueadas mostram mensagem clara em vez de erro genérico ("Ação não permitida em sessão de suporte"), e botões de escrita ficam desabilitados quando a sessão é somente leitura.
- **Administradores da empresa**: faixa/aviso discreto "A equipe de suporte acessou sua conta em … Motivo: …" com **Dispensar** (nunca mostra identidade pessoal do Master).
- **Ficha da empresa (Master)**: seção **Histórico de suporte** (lista das sessões).
- Textos em português; temas claro e escuro.

## 7. Testes obrigatórios

Crie `backend/scripts/e2e-master-fase4.mjs` e teste no navegador:

1. Só Master inicia suporte (outros 403); sem motivo ou com motivo curto → 400; empresa suspensa/Plataforma/inexistente → 4xx; com modo teste ativo → 409 (e o inverso).
2. Em suporte **somente leitura**: leituras funcionam (produtos, pedidos, relatórios da empresa **acessada**); qualquer escrita → 403; o Master **não** enxerga dados de **outra** empresa durante a sessão.
3. Com **edição liberada**: editar um produto funciona e a auditoria registra `master` como autor com `suporte: true`; as **ações sempre bloqueadas** (usuários, senhas, 2FA, planos, exportação, backups, `/api/master/*`) dão 403.
4. **Expiração**: após 30 min (simule `expira_em` vencido) a próxima requisição dá 401 e a sessão consta como `expirou`; **não** há renovação; encerrar manualmente devolve token de Master puro e a sessão consta `master`.
5. Invalidação: trocar a senha do Master / `sessoes_validas_desde` / desativar o Master derruba a sessão de suporte.
6. Aviso: com `avisar` ligado, administradores da empresa recebem o aviso (com motivo, **sem nome pessoal do Master**) e conseguem dispensar; com desligado, não recebem; usuários não administradores não veem.
7. Auditoria global mostra início/fim e as escritas do suporte com tipo `suporte` e a empresa certa; histórico de suporte na ficha da empresa bate.
8. Isolamento: usuários da empresa acessada **não** são afetados (nenhuma sessão deles cai; eles não veem o Master como usuário).
9. Faixa fixa visível em todas as páginas e com contagem regressiva; temas claro e escuro.
10. Regressão: login comum, PDV, pedidos, clientes, Master (Fases 1–3), modo teste e `npm run test:e2e:modo-teste`.

## 8. Fora do escopo

Aprovação prévia da empresa antes do acesso, aviso por e-mail/WhatsApp, gravação de tela, acesso de suporte para usuários que não sejam Master, delegação de suporte a terceiros.

## 9. Ordem sugerida de commits

1. Migration + `sessoes_suporte`/`avisos_empresa`. 2. Iniciar/encerrar suporte e JWT com claim. 3. Perfil efetivo e auditoria marcada em `authRequired`/`audit.js`. 4. Restrições (somente leitura, lista de ações bloqueadas) e exclusividade com modo teste. 5. Avisos para administradores e histórico. 6. Front: modal, faixa com contagem, histórico, avisos. 7. e2e e ajustes de tema.

## 10. Entrega

Rode os testes da seção 7 e faça um **relatório em português**: o que foi feito por commit, decisões tomadas (lista de ações bloqueadas, reautenticação por 2FA, etc.), resultados (inclusive falhas), pendências e funcionalidades existentes que você **não removeu** mas notou conflito. Não repita segredos nem JWTs.

# Prompt — Verificação em duas etapas (2FA) com Google Authenticator (TOTP + QR code)

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Não há preview de tela; as telas devem seguir o estilo atual do sistema (paleta "dourado contido", temas claro e escuro). A viabilidade já foi verificada (ver seção 2).

---

## 1. Objetivo

Adicionar **2FA por aplicativo autenticador** (Google Authenticator, Microsoft Authenticator, Authy, 1Password… — todos usam o mesmo padrão aberto **TOTP, RFC 6238**):

- o usuário ativa o 2FA lendo um **QR code** (ou digitando a chave) e confirmando com um código;
- no login, depois da senha, pede o **código de 6 dígitos**;
- **códigos de recuperação** (uso único) para quem perder o celular;
- **obrigatório para o Master**; opcional para os demais, com opção de **exigir por usuário** (ajuste feito por quem administra);
- reset do 2FA por quem administra (com auditoria) e comando de emergência por script.

Decisões já tomadas (não rediscutir): sem custo e sem serviço externo; **TOTP SHA-1, 6 dígitos, período 30 s** (o Google Authenticator ignora outros parâmetros); QR gerado **no servidor**, nunca por site/serviço de terceiros.

## 2. O que já foi verificado (não refazer)

- Fora do projeto foi provado que um TOTP escrito só com o módulo `crypto` do Node passa nos **6 vetores de teste do RFC 6238** (SHA-1, 8 dígitos) e que a codificação base32 vai e volta. Use essa abordagem: **implementação própria, sem biblioteca de TOTP**, para rodar tanto no Node 14 do cPanel quanto no Node 20 do Docker. Não use `otpauth`/`otplib` (dependem de pacotes novos cuja versão mínima de Node não foi confirmada) nem `speakeasy` (sem manutenção).
- Para o QR use o pacote **`qrcode`** (`^1.5.4`, exige Node ≥ 10.13): `QRCode.toDataURL(uri)` devolve um PNG em data URL.
- Formato do endereço do QR: `otpauth://totp/GiroStock:<email-url-encoded>?secret=<BASE32 sem padding>&issuer=GiroStock&algorithm=SHA1&digits=6&period=30` (label e issuer com URL-encode; segredo em base32 sem `=`).
- O servidor precisa ter o **relógio sincronizado** (NTP); documente isso no deploy.

Implementação de referência do núcleo (use como base, com testes — veja seção 8):
```js
const crypto = require('crypto');
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32enc = (buf) => { let bits = '', out = ''; for (const x of buf) bits += x.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += ALFABETO[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
const b32dec = (s) => { let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) bits += ALFABETO.indexOf(c).toString(2).padStart(5, '0');
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
function hotp(chave, contador, digitos = 6) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(contador));
  const h = crypto.createHmac('sha1', chave).update(b).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digitos).padStart(digitos, '0');
}
const passo = (t = Date.now() / 1000) => Math.floor(t / 30);
```
Compare códigos com `crypto.timingSafeEqual`. Segredo = `crypto.randomBytes(20)` (160 bits).

## 3. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: mantenha e liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador e por requisições reais; build não basta.
- Antes de criar a migration rode `ls backend/src/db/migrations` e use o **próximo número livre** (a última conhecida é `017_perfil_master.sql`, mas pode haver mais).
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Nunca** imprima/registre segredos TOTP, códigos de recuperação em texto, senhas, tokens ou chaves de ambiente em log, auditoria, resposta que não seja a da ativação ou relatório.
- **Não quebre** o login atual, o modo teste, o perfil Master nem a troca de senha. Teste o login de um usuário **sem** 2FA depois de cada mudança no fluxo.

## 4. Estado atual (para se localizar)

- `backend/src/routes/auth.routes.js`: `POST /auth/login` (valida e-mail/senha, devolve `{ token, usuario }`), `GET /auth/me`, `POST /auth/change-password`, `POST /auth/modo-teste`. Login e permissões usam **sempre a produção** (`pool.producao`, modo teste usa banco separado). Função `assinar(user, extra)` gera o JWT.
- `backend/src/middleware/auth.js` (`authRequired`): valida o JWT, recarrega o usuário a cada requisição. **Precisa passar a recusar tokens de 2FA pendente.**
- `backend/src/middleware/permissions.js`: `MATRIX`, `PERMISSOES` (ajustáveis por usuário), `requireArea`. Perfil `Master` já existe (empresa "Plataforma", criado por `backend/scripts/master.js`).
- `backend/scripts/usuarios.js` e `master.js`: administração por script (padrão a seguir para o reset de emergência).
- `backend/src/utils/audit.js` (`logAudit`), `utils/http.js` (`HttpError`).
- Frontend: `src/api/client.js` (sessão em localStorage), `context/AuthContext.jsx` (`login`, `logout`, `alternarModoTeste`), `pages/Login.jsx`, `pages/Users.jsx` (matriz de permissões por usuário), `pages/Master.jsx` (se existir), `App.jsx` (menu/conta).

## 5. Banco de dados (migration `0NN_2fa.sql`)

Em `users` (colunas nulas por padrão):
- `totp_segredo_cript TEXT` — segredo **criptografado** (AES-256-GCM, formato `iv:tag:cifrado` em base64); **nunca** em texto puro.
- `totp_ativo BOOLEAN NOT NULL DEFAULT false`
- `totp_ativado_em TIMESTAMPTZ`
- `totp_ultimo_passo BIGINT` — último passo (contador de 30 s) aceito, para **impedir reuso do mesmo código**.
- `totp_exigido BOOLEAN NOT NULL DEFAULT false` — administração exige 2FA deste usuário (Master é sempre exigido pelo código, independente da coluna).
- `totp_falhas INT NOT NULL DEFAULT 0` e `totp_bloqueado_ate TIMESTAMPTZ` — limite de tentativas.

Tabela `user_recovery_codes`: `id`, `user_id`, `codigo_hash` (hash forte do código; use `bcryptjs` já presente), `usado_em`, `criado_em`; índice por `user_id`.

Chave de criptografia: variável de ambiente **`TOTP_ENC_KEY`** (32 bytes em base64/hex). Documente em `.env.example` e nos arquivos de deploy; se ausente em produção, o 2FA fica indisponível (erro claro na inicialização) em vez de gravar em texto puro. Em desenvolvimento pode haver uma chave padrão **apenas** quando `NODE_ENV !== 'production'`.

## 6. Back-end

Serviço `backend/src/services/totp.js` com: `gerarSegredo()`, `cifrar/decifrar`, `uriOtpauth(email, segredoBase32)`, `qrDataUrl(uri)` (`qrcode`), `verificar(segredoBase32, codigo, ultimoPasso)` — aceita **janela de ±1 passo** (tolerância de relógio), rejeita passo ≤ `totp_ultimo_passo` e devolve o passo aceito; `gerarCodigosRecuperacao()` (10 códigos de 10 caracteres legíveis, ex. `xxxxx-xxxxx`).

### 6.1 Login em dois passos
- `POST /auth/login`: se a senha estiver correta **e** o usuário tem `totp_ativo`, **não** devolve o token completo: devolve `{ mfa: 'pendente', token_mfa }`, onde `token_mfa` é um JWT **de 5 minutos** com claim `mfa: 'pendente'` (e `sub`). Sem 2FA: comportamento atual inalterado.
- **Obrigatoriedade:** se o usuário é **Master** (ou `totp_exigido`) e ainda **não ativou** o 2FA, o login devolve `{ mfa: 'configurar', token_mfa }` (token de 15 min com claim `mfa: 'configurar'`), que só vale para as rotas de ativação (6.2) — ele não consegue usar o sistema até ativar.
- `POST /auth/2fa/verificar` `{ token_mfa, codigo }` (rota pública, mas exige `token_mfa` válido com `mfa:'pendente'`): aceita o código TOTP **ou** um código de recuperação (marca como usado, auditoria "login com código de recuperação" e avise quantos restam). Em sucesso devolve o **mesmo** `{ token, usuario }` do login normal e zera `totp_falhas`. Em erro incrementa `totp_falhas`; a partir de **5** erros bloqueia por **15 minutos** (`totp_bloqueado_ate`) e responde 429. Mensagem de erro genérica ("código inválido").
- `authRequired` e qualquer outra rota protegida **devem rejeitar** tokens com claim `mfa` (somente as rotas de 2FA aceitam esses tokens). Teste explicitamente que um `token_mfa` **não** abre `/api/...` de negócio.

### 6.2 Ativar, desativar, recuperação
Rotas autenticadas (token completo **ou** `token_mfa` com `mfa:'configurar'` apenas nas duas primeiras):
- `POST /auth/2fa/preparar`: gera segredo novo (ainda **não ativo**), guarda cifrado, devolve `{ qr (data URL PNG), chave (base32 para digitar), uri }`. Chamar de novo gera outro segredo enquanto não ativado. Se já ativo, 409.
- `POST /auth/2fa/ativar` `{ codigo }`: confere o código contra o segredo preparado; se correto, `totp_ativo=true`, `totp_ativado_em`, grava `totp_ultimo_passo`, gera os **10 códigos de recuperação** (guarda só o hash) e os devolve **uma única vez**. Auditoria `ativar_2fa`. Se veio de `mfa:'configurar'`, devolve também o token completo (login concluído).
- `POST /auth/2fa/desativar` `{ senha, codigo }` (token completo): exige senha **e** código atual; **Master não pode desativar** (403) e quem tem `totp_exigido` também não. Auditoria `desativar_2fa`.
- `POST /auth/2fa/codigos-recuperacao` `{ senha, codigo }`: gera novo conjunto de 10 (invalida os anteriores) e mostra uma vez.
- `GET /auth/me` passa a incluir `doisFatores: { ativo, exigido, codigosRestantes }` (nunca o segredo).

### 6.3 Administração
- `POST /users/:id/2fa/resetar` (área `Configuracoes` para usuários da própria empresa — Administrador **não** pode resetar Master; o **Master** pode resetar qualquer um): zera `totp_*` e apaga códigos de recuperação; o usuário reativa no próximo login (se for exigido) ou quando quiser. Auditoria `resetar_2fa` com quem fez. Em `PATCH /users/:id` permitir ajustar `totp_exigido` (por usuário); **Master** (perfil) sempre exigido.
- `Users.jsx`: coluna/etiqueta "2FA ativo / não ativo / exigido", ação "Resetar 2FA" (com confirmação) e opção "Exigir 2FA" no formulário do usuário.
- Script de emergência `backend/scripts/resetar-2fa.js` + `npm run resetar-2fa` (padrão do `usuarios.js`): `RESET_EMAIL=...` zera o 2FA desse usuário (inclusive Master) e imprime só "2FA resetado para <nome> <email>". Documente no deploy que o Master que perder o celular **e** os códigos usa esse comando no servidor.

### 6.4 Modo teste e cópia da produção
O login é sempre na produção, então o 2FA **não** se aplica ao banco de teste. Na **cópia produção → teste** os campos `totp_*` e `user_recovery_codes` devem ser **zerados/ignorados** na cópia: nunca copie segredos para o banco de teste. Confira esse trecho em `services/modoTeste*.js` (ou onde a cópia estiver).

### 6.5 Segurança adicional
- Cifre o segredo com AES-256-GCM (IV aleatório por gravação). Nunca devolva o segredo depois da ativação.
- Limite de tentativas também em `/auth/login` já existente? Se não houver, **não crie agora**; apenas liste no relatório.
- Códigos TOTP comparados em tempo constante; mesmo código não vale duas vezes (`totp_ultimo_passo`).
- Registrar na auditoria (`logAudit`): ativar, desativar, resetar, uso de código de recuperação, bloqueio por tentativas. **Sem** conteúdo de códigos/segredos.

## 7. Front-end

Estilo atual do sistema (`--bg`, `--panel`, `--gold-light`, `--ok`, `--warn`, `--err`; temas claro/escuro; sem gradientes antigos). Textos em português.

1. **Login (`Login.jsx`)**: após e-mail/senha, se a resposta for `mfa: 'pendente'` mostrar o passo **"Código de verificação"**: campo de 6 dígitos (foco automático, só números, envia ao completar), link "Usar código de recuperação", botão "Voltar". Mostrar erro e o bloqueio ("tente novamente em X min" ao receber 429).
2. **Ativação forçada** (`mfa: 'configurar'`, Master/exigido): tela cheia "Proteja sua conta" com o passo a passo (instalar um app autenticador, ler o QR, digitar o código), sem acesso ao resto do sistema até concluir; ao concluir, mostra os **códigos de recuperação** e só entra no sistema depois de o usuário marcar "Guardei meus códigos".
3. **Ativação voluntária**: em "Minha conta"/menu do usuário, "Segurança → Verificação em duas etapas": estado, botão **Ativar** (mesmo fluxo da tela acima, em modal), **Gerar novos códigos de recuperação** e **Desativar** (pede senha + código; indisponível para Master/exigido com explicação).
4. **QR code**: exibir a imagem recebida (data URL) com a **chave em texto** abaixo (para digitar à mão) e o texto "Escaneie com o Google Authenticator, Microsoft Authenticator ou similar". Botões "Baixar/Imprimir códigos de recuperação" e "Copiar".
5. `AuthContext`: `login` retorna o estado `mfa` quando for o caso; novas funções `verificarCodigo`, `prepararDoisFatores`, `ativarDoisFatores`, etc. Não persistir o `token_mfa` em localStorage (só em memória).
6. Painel `/master` (se existir): aviso/atalho "Ativar 2FA" enquanto não ativo — mas como o Master é obrigado, o aviso só aparece em contexto de ajuda ("2FA ativo ✔").

## 8. Testes obrigatórios (rodar e mostrar o resultado)

Crie `backend/scripts/e2e-2fa.mjs` (padrão dos e2e existentes) **e** teste no navegador:

1. Núcleo TOTP: os **6 vetores do RFC 6238** (SHA-1, segredo ASCII `12345678901234567890`, 8 dígitos: t=59→`94287082`, 1111111109→`07081804`, 1111111111→`14050471`, 1234567890→`89005924`, 2000000000→`69279037`, 20000000000→`65353130`) e ida/volta do base32.
2. Janela: código do passo anterior e do seguinte aceitos; dois passos de distância recusados; **mesmo código usado duas vezes** recusado.
3. Fluxo completo com um usuário comum: preparar → ativar com código válido (recebe 10 códigos) → logout → login pede código → login com código correto entra; com código errado falha; 5 erros bloqueiam por 15 min (429).
4. `token_mfa` **não** abre nenhuma rota de negócio (ex.: `GET /api/products` → 401/403); `token_mfa` de `mfa:'configurar'` só abre preparar/ativar.
5. Código de recuperação funciona **uma vez**; restantes diminuem; novos códigos invalidam os antigos.
6. Master sem 2FA ativo é forçado a configurar no primeiro login e **não** consegue desativar depois; Administrador comum pode ativar/desativar; Administrador **não** reseta o Master; Master reseta qualquer usuário; script `npm run resetar-2fa` funciona.
7. Segredo no banco **não** está em texto puro (consulte a coluna e confirme o formato cifrado); `GET /auth/me` e demais respostas **não** vazam segredo/códigos; auditoria gravada sem conteúdo sensível.
8. Cópia produção → teste **não** leva segredos TOTP nem códigos de recuperação.
9. Regressão: login de usuário **sem** 2FA, troca de senha, modo teste, PDV continuam funcionando; temas claro e escuro nas telas novas.
10. Confirme com um app autenticador real (ou um segundo gerador TOTP independente, como outra implementação) que o QR/URI gerado produz o **mesmo código** que o servidor aceita. Se não houver celular disponível, descreva como foi validado e marque como **pendente de teste manual**.

## 9. Fora do escopo (não implementar agora)

- "Entrar com Google" (OAuth), SMS ou e-mail como segundo fator, chaves de segurança (WebAuthn/passkeys).
- Limite de tentativas no endpoint de senha (`/auth/login`) e outras proteções gerais (apenas listar no relatório se não existirem).
- Política "exigir 2FA para toda a empresa" (por ora é por usuário).

## 10. Ordem sugerida de commits

1. Migration + `TOTP_ENC_KEY` + serviço `totp.js` com testes do núcleo.
2. Rotas de preparar/ativar/desativar/códigos de recuperação.
3. Login em dois passos e bloqueio de tokens pendentes no `authRequired`.
4. Obrigatoriedade do Master e `totp_exigido`; reset por administração e script de emergência.
5. Cópia produção → teste sem segredos.
6. Frontend: login com código, ativação (QR), segurança na conta, `Users.jsx`.
7. Script e2e, ajustes de tema e documentação de deploy (`TOTP_ENC_KEY`, relógio NTP).

## 11. Entrega

Ao final, rode todos os testes da seção 8 e faça um **relatório em português** com: o que foi feito por commit, decisões tomadas, resultados dos testes (inclusive os que falharam ou ficaram pendentes), pendências e qualquer funcionalidade existente que você **não removeu** mas notou conflito. Informe os comandos novos (`npm run resetar-2fa`) e a variável `TOTP_ENC_KEY` **sem repetir valores secretos**.

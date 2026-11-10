# Publicar o GiroStock no cPanel (Hostmidia) — girostock.calutec.com.br

O servidor do cPanel é antigo (glibc 2.12, tipo CentOS 6): só roda o **Node 14.21.2** do seletor do cPanel.
O backend já está fixado em bibliotecas compatíveis (`helmet` 6.2.0, `pg` 8.11.3, sem `redis`).
Se a conta for migrada para um servidor mais novo, basta trocar a versão do Node no seletor.

## 0. Mensagem para o suporte da Hostmidia (opcional, recomendada)

> Olá! Minha conta (usuário calutecc, domínio calutec.com.br) está num servidor cujo Node.js Selector só oferece até a versão 14, e o sistema operacional não roda Node 16/18/20 (erros de GLIBC 2.14+ ausentes). Vocês têm servidores com CloudLinux 8/9 (ou AlmaLinux 9) com Node.js 18 ou 20 no seletor e PostgreSQL 13+? Podem migrar minha conta para um deles? Também preciso saber a versão do PostgreSQL do plano e se as extensões `pgcrypto` e `citext` estão liberadas. Obrigado!

## 1. Subdomínio
cPanel → **Domínios** → criar `girostock.calutec.com.br`.
Aponte a raiz do documento para uma pasta como `/home/calutecc/girostock/public`.
Depois, em **SSL/TLS Status**, rode o AutoSSL para o subdomínio.

## 2. Banco PostgreSQL
cPanel → **Bancos de dados PostgreSQL**:
1. Criar o banco `girostock` (o cPanel coloca o prefixo: `calutecc_girostock`).
2. Criar um usuário com senha forte e associar ao banco com todos os privilégios.
3. Em **phpPgAdmin** (ou `psql`), rodar no banco:
   ```sql
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   CREATE EXTENSION IF NOT EXISTS citext;
   ```
   Se der erro de permissão, pedir ao suporte para liberar as duas extensões.

## 3. Enviar o código
Mantenha a estrutura do repositório, porque o backend serve `../../frontend/dist`:
```
/home/calutecc/girostock/
  backend/   (código do backend, SEM node_modules)
  frontend/dist/   (build do frontend)
```
- Gere o build no seu computador: `cd frontend && npm run build`.
- Envie `backend/` (sem `node_modules` e sem `.env`) e `frontend/dist/` pelo Gerenciador de arquivos (zip) ou por `git clone` no Terminal.

## 4. Aplicativo Node.js
cPanel → **Setup Node.js App** → Criar aplicação:
- Versão do Node.js: **14.21.2**
- Modo: **Production**
- Raiz do aplicativo: `girostock/backend`
- URL do aplicativo: `girostock.calutec.com.br`
- Arquivo de inicialização: `src/server.js`
- Variáveis de ambiente:
  - `NODE_ENV` = `production`
  - `DATABASE_URL` = `postgres://USUARIO:SENHA@127.0.0.1:5432/calutecc_girostock`
  - `DATABASE_NOME_TESTE` = (atalho, mais simples) só o **nome** do segundo banco, ex.: `calutecc_girostock_teste`; o sistema usa o mesmo servidor, usuário e senha da `DATABASE_URL`. Use esta **ou** a `DATABASE_URL_TESTE`.
  - `DATABASE_URL_TESTE` = (opcional) outro banco PostgreSQL, ex.: `calutecc_girostock_teste`, para o Modo teste. Sem ela (ou igual a `DATABASE_URL`) o modo teste fica indisponivel. Crie o banco no cPanel e associe o mesmo usuario; o `npm run migrate` passa a migrar os dois.
  - `JWT_SECRET` = (texto longo e aleatório)
  - `JWT_EXPIRES_IN` = `8h`
  - `TOTP_ENC_KEY` = chave do 2FA (32 bytes em base64 ou 64 hexadecimais). Gere com `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`, digite você mesmo no painel e **guarde uma cópia**: sem ela os 2FA ativos deixam de funcionar. Sem a variável, o 2FA fica indisponível (e o Master não consegue entrar, pois o 2FA dele é obrigatório).
  - **Trocar de celular (com o app antigo ainda funcionando):** menu da conta → Verificação em duas etapas → *Trocar de celular / reconfigurar* (vale também para o Master). Pede senha e um código atual, mostra o QR novo e só troca depois de confirmar com o app novo; gera 10 novos códigos de recuperação.
  - **Master sem celular e sem códigos de recuperação:** rode no servidor `RESET_EMAIL=<e-mail do Master> npm run resetar-2fa` (script "resetar-2fa" em "Correr script JS"; não mostra segredos). No próximo login ele configura o app de novo.
- Clique em **Run NPM Install** e depois em **Restart**.
(A porta é definida pelo Passenger; o servidor lê `process.env.PORT`.)

## 5. Tabelas e usuário inicial
No **Terminal** do cPanel (use o comando que o próprio Setup Node.js App mostra no topo para ativar o ambiente, algo como `source /home/calutecc/nodevenv/girostock/backend/14/bin/activate && cd /home/calutecc/girostock/backend`):
```bash
npm run migrate
npm run seed
```
O seed cria o administrador de teste (`admin@girostock.local` / `admin123`): **troque a senha no primeiro acesso**.

## 6. Conferir
- `https://girostock.calutec.com.br/health` deve responder `{"status":"ok"}`.
- Entre no sistema, abra o caixa e faça uma venda de teste.
- Se der erro 500/503, veja o log em `girostock/backend/` (arquivo de log do Passenger) ou no Setup Node.js App.

## Cuidados
- Node 14 não recebe mais correções de segurança: mantenha o sistema atrás de senha forte e HTTPS.
- Faça backup do banco com frequência (cPanel → **Backup** ou `pg_dump`).

## Senhas na produção (regra)
- **Nenhuma senha vem do ambiente local.** Local e produção são bancos separados: usuários e senhas de um nunca valem no outro.
- O `npm run seed` cria `admin@girostock.local` com a senha pública `admin123`. **Troque na hora**, antes de qualquer uso:
  1. No app (Setup Node.js App), adicione as variáveis `RESET_EMAIL` e `RESET_PASSWORD` (a senha nova é digitada por quem administra).
  2. Rode o script `usuarios` (`npm run usuarios`): redefine a senha desse e-mail. Sem as variáveis, ele só lista os usuários (sem senhas).
  3. **Remova as duas variáveis** e reinicie o app.
- O Master de produção é criado com `npm run master` usando `MASTER_EMAIL`, `MASTER_PASSWORD` (mín. 8 caracteres) e `MASTER_NOME` digitados no ambiente; remova-as depois.
- Use senhas fortes e únicas, guardadas em um gerenciador de senhas. Não coloque senhas em arquivos versionados nem em mensagens.

## Relógio do servidor (2FA)
O 2FA por aplicativo (TOTP) depende de o relógio do servidor estar correto: mantenha o **NTP** ativo (no cPanel/WHM isso é do provedor). Relógio atrasado ou adiantado mais de ~30 s faz os códigos válidos serem recusados.

## Backups e restauração (Painel Master)
- **Pasta dos backups:** defina `BACKUP_DIR` com uma pasta **fora** do `public_html` e fora do código (ex.: `/home/calutecc/backups-girostock`). Sem a variável, usa `backend/backups` (já ignorada pelo git). A aba "Backups & dados" mostra o erro se a pasta não for gravável.
- **Sem `pg_dump` no cPanel:** o sistema gera backups em formato próprio (`.gbk.gz`, feito em JavaScript). Com `pg_dump` disponível (ou `PG_BIN_DIR` apontando para a pasta dele), usa `pg_dump -Fc`.
- **Rotina diária:** roda dentro do processo do app, todo dia depois da hora configurada em Configurações globais (padrão 03:00, hora do servidor), e guarda os automáticos por 30 dias (os manuais nunca são apagados sozinhos). Se o app ficar parado nessa hora, o backup sai assim que ele voltar a rodar no mesmo dia.
- **Restaurar pela tela:** só vai para o **banco de teste**. Nunca toca na produção.
- **Restaurar na produção (só pelo servidor):** `BACKUP_ARQUIVO=<nome do arquivo em BACKUP_DIR> npm run restaurar-backup` (script "restaurar-backup" em "Correr script JS"). Ele mostra a data do backup e quantos registros serão perdidos, pede para digitar `RESTAURAR PRODUCAO`, gera um backup de segurança antes, liga o modo manutenção, restaura numa única transação (se falhar, nada muda), registra a auditoria e desliga a manutenção. **Como o Terminal do cPanel pode estar indisponível, o script precisa de entrada digitada: rode-o por SSH ou peça apoio do suporte; não há botão na tela de propósito.**
- **Migração nova:** `021_master_backups_config.sql` (rode `npm run migrate`; junto com 017–020).

## Deploy automático pelo Git (GitHub → cPanel)
Fluxo: você faz `git push` na `main` → o GitHub Actions (`.github/workflows/producao.yml`) confere a sintaxe, compila o frontend e publica a branch **`producao`** (main + `frontend/dist`) → um **Cron do cPanel** roda `scripts-servidor/atualizar.sh` a cada 5 minutos: se a `producao` tem commit novo, atualiza o código, roda `npm install` (só se o `package-lock.json` mudou), aplica as **migrações** e reinicia o app. `.env`, `node_modules` e backups não são tocados.
- **Primeira vez (uma só):** com a branch `producao` já publicada, rodar uma única vez no servidor (Cron de execução única): `cd /home/calutecc/repositories/GiroStock && git init -q && git remote add origin https://github.com/lucasmendesinf/GiroStock.git && git fetch -q origin producao && git reset -q --hard origin/producao`. Depois, criar o Cron permanente: `*/5 * * * * /bin/bash /home/calutecc/repositories/GiroStock/scripts-servidor/atualizar.sh`.
- **Log:** `/home/calutecc/logs/deploy-girostock.log`. Erro em qualquer passo (ex.: migração) para ali e o app segue na versão anterior.
- **Pausar o deploy automático:** desligue o Cron (Trabalhos Cron). Voltar versão: `git revert` na main e push.
- **Atenção:** migrações rodam sozinhas a cada deploy; revise o que vai para a `main`.

## Endereço das lojas: `nome-da-loja.girostock.calutec.com.br`

Cada loja virtual (varejo ou cardápio de delivery) ganha sozinha um endereço próprio, com o nome da empresa:
`ja-conveniencia.girostock.calutec.com.br`, `lanchonete-sao-joao.girostock.calutec.com.br`… O endereço é criado na hora em
que a loja da empresa é aberta pela primeira vez (Loja virtual no painel) e pode ser trocado pelo Master (ficha da empresa →
Loja virtual → subdomínio, ex.: só `ja`). Não é preciso mexer na hospedagem a cada cliente novo: isso é configurado **uma
vez só**, com um subdomínio curinga.

1. **Subdomínio curinga.** cPanel → **Domínios** → Criar domínio: `*.girostock.calutec.com.br`, com a **mesma raiz do
   documento** do `girostock.calutec.com.br` (ex.: `/home/calutecc/girostock/public`). Assim o mesmo aplicativo Node atende
   todas as lojas (o `.htaccess` do Passenger que o Setup Node.js App gravou nessa pasta vale para os dois).
2. **DNS.** Se o DNS do `calutec.com.br` fica no próprio cPanel, o passo 1 já cria o registro `*.girostock` apontando para o
   servidor (confira em **Zone Editor**). Se o DNS estiver em outro lugar (Registro.br, Cloudflare…), crie lá um registro
   `A` para `*.girostock` com o mesmo IP do `girostock.calutec.com.br`.
3. **Certificado (cadeado).** Em **SSL/TLS Status**, rode o AutoSSL e confira se `*.girostock.calutec.com.br` ficou com
   certificado. O certificado curinga exige que o AutoSSL da hospedagem use Let's Encrypt com o DNS no próprio servidor;
   se não aparecer, peça ao suporte da Hostmidia: *"preciso de certificado SSL curinga para *.girostock.calutec.com.br"*.
4. **Variáveis do app** (Setup Node.js App): `LOJA_DOMINIO_BASE=girostock.calutec.com.br` e
   `URL_PUBLICA=https://girostock.calutec.com.br`. Reinicie o app.
5. **Conferir:** abra a Loja virtual de uma empresa → *Link da loja*: deve mostrar `https://<nome>.girostock.calutec.com.br`
   (com *Copiar link*, *Enviar pelo WhatsApp* e o QR Code para imprimir). Abra o link no celular.

Enquanto o curinga não estiver pronto, toda loja já funciona pelo link reserva, sem configurar nada:
`https://girostock.calutec.com.br/loja/<nome>/`.

## Nota fiscal (NFC-e): PHP no servidor

O módulo de nota fiscal usa o PHP do servidor (linha de comando) para assinar e enviar as notas. Precisa de PHP 8.1+ com
`curl dom json libxml mbstring openssl simplexml zlib`. Confira no Terminal do cPanel, dentro da pasta do sistema:

    echo '{"acao":"diagnostico"}' | php backend/fiscal/motor.php

Se o `php` padrão for antigo, use o do MultiPHP (ex.: `/opt/cpanel/ea-php83/root/usr/bin/php`) e informe esse caminho na
variável `FISCAL_PHP` do aplicativo Node.js. Detalhes em `docs/nota-fiscal.md`.

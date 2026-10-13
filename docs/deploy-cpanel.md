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
  - `DATABASE_URL_TESTE` = (opcional) outro banco PostgreSQL, ex.: `calutecc_girostock_teste`, para o Modo teste. Sem ela (ou igual a `DATABASE_URL`) o modo teste fica indisponivel. Crie o banco no cPanel e associe o mesmo usuario; o `npm run migrate` passa a migrar os dois.
  - `JWT_SECRET` = (texto longo e aleatório)
  - `JWT_EXPIRES_IN` = `8h`
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

# Pendências no servidor (cPanel) — contexto para a sessão local

> Cole este arquivo como contexto numa sessão do Claude Code no computador (com acesso ao navegador e ao cPanel).
> Regras: responder em português; **nunca** colocar senhas/chaves em chat, arquivos ou commits (quem digita senha é o
> usuário, direto no painel); não rodar `npm run seed` na produção; não mexer no `.env` nem no banco à mão; confirmar com
> o usuário antes de qualquer ação difícil de desfazer.

## O sistema

- **GiroStock**: Node/Express + PostgreSQL + React. Repositório `lucasmendesinf/GiroStock`.
- Produção: `https://girostock.calutec.com.br`, hospedagem **Hostmidia (cPanel)**, usuário `calutecc`.
- **Deploy automático:** push na `main` → GitHub Actions publica a branch `producao` (com `frontend/dist`, `loja/dist` e
  `backend/fiscal/vendor`) → um **Cron do cPanel** (a cada 5 min) roda
  `/home/calutecc/repositories/GiroStock/scripts-servidor/atualizar.sh`: atualiza o código, `npm install` se o lock mudou,
  roda as **migrações** e reinicia o app.
  - Pasta do código: `/home/calutecc/repositories/GiroStock` (app Node: `.../GiroStock/backend`, Node 22,
    ambiente `/home/calutecc/nodevenv/repositories/GiroStock/backend/22/bin/activate`).
  - Log do deploy: `/home/calutecc/logs/deploy-girostock.log`.
  - Variáveis do app: cPanel → **Setup Node.js App** → app do GiroStock → *Environment variables* → salvar → **Restart**.
- Documentação no repositório: `docs/deploy-cpanel.md` (servidor) e `docs/nota-fiscal.md` (nota fiscal).

## O que acabou de ir para produção

- `main` = `7877599`, build `producao` = `960cbab`. O que entrou: nota fiscal NFC-e (configuração por loja, cupom fiscal no
  PDV, contingência, cancelamento junto com a venda, lista de notas que precisam de devolução e NF-e de devolução com DANFE).
- Migrações novas, aplicadas sozinhas pelo cron: `045_fiscal.sql` e `046_fiscal_devolucao.sql`.
- Antes disso já estavam em produção: loja virtual/delivery, garçom, eventos (agenda, estoque do evento, pop-up no site),
  relatório por evento, cardápio digital e permissões de edição.

## Tarefas (em ordem)

### 1. Conferir se o deploy chegou
- No Terminal do cPanel: `tail -20 /home/calutecc/logs/deploy-girostock.log` → deve ter
  `ok: app reiniciado em 960cbab` e as linhas das migrações 045/046 sem erro.
- `https://girostock.calutec.com.br/health` → `{"status":"ok"}`.
- Se a migração falhou: o app segue na versão anterior. Ler o erro no log e trazer para análise (não corrigir o banco à mão).

### 2. Nota fiscal: PHP no servidor (obrigatório para emitir)
O backend chama o PHP em linha de comando (`backend/fiscal/motor.php`, biblioteca NFePHP) para assinar e enviar as notas.
Precisa de **PHP 8.1+** com `curl dom json libxml mbstring openssl simplexml zlib` (e `gd` para o PDF do DANFE).

```bash
cd /home/calutecc/repositories/GiroStock
php -v
echo '{"acao":"diagnostico"}' | php backend/fiscal/motor.php
```
- Esperado: `{"ok":true,"php":"8.x","faltam":[]}`.
- Se o `php` padrão for velho ou faltar extensão, procurar os PHPs do MultiPHP e testar cada um:
  ```bash
  ls /opt/cpanel/ea-php*/root/usr/bin/php
  echo '{"acao":"diagnostico"}' | /opt/cpanel/ea-php83/root/usr/bin/php backend/fiscal/motor.php
  ```
  O que der `ok:true`: colocar o caminho na variável **`FISCAL_PHP`** do app Node (Setup Node.js App) e reiniciar.
- Conferir o `gd`: `/caminho/do/php -m | grep -i gd`. Faltando extensão: cPanel → *Select PHP Version* / *MultiPHP*
  (se existir) ou pedir ao suporte da Hostmidia para habilitar no PHP 8.x.
- **Não** definir `FISCAL_SIMULADOR` na produção (é só para testes).
- Opcional: responsável técnico na nota (`FISCAL_RESP_TEC_CNPJ`, `FISCAL_RESP_TEC_CONTATO`, `FISCAL_RESP_TEC_EMAIL`,
  `FISCAL_RESP_TEC_FONE`) — perguntar ao usuário se quer (CNPJ da Calutec).

### 3. Subdomínio curinga das lojas de delivery
Cada loja virtual ganha `nome-da-loja.girostock.calutec.com.br`. Configura-se **uma vez** (detalhes em
`docs/deploy-cpanel.md`, seção "Endereço das lojas"):
1. cPanel → **Domínios** → criar `*.girostock.calutec.com.br` com a **mesma raiz do documento** do
   `girostock.calutec.com.br` (ver qual é no próprio cPanel).
2. **Zone Editor**: conferir o registro `*.girostock` apontando para o IP do servidor (se o DNS for externo, criar lá um `A`).
3. **SSL/TLS Status** → rodar AutoSSL e conferir o certificado do curinga. Sem curinga, pedir à Hostmidia:
   "preciso de certificado SSL curinga para *.girostock.calutec.com.br".
4. Variáveis do app: `LOJA_DOMINIO_BASE=girostock.calutec.com.br` e `URL_PUBLICA=https://girostock.calutec.com.br` → Restart.
5. Conferir: GiroStock → Loja virtual → *Link da loja* mostra `https://<nome>.girostock.calutec.com.br` e abre.

### 4. E-mail (SMTP) do sistema, se ainda não estiver configurado
Variáveis do app: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USUARIO`, `SMTP_SENHA`, `SMTP_REMETENTE` (ex.: uma conta de e-mail do
próprio cPanel em *Contas de e-mail*). **A senha quem digita é o usuário**, direto no painel.

### 5. Site da J&A (jaconveniencia.com.br) — agenda de eventos e pop-up
O site é PHP, feito pela Calutec, na hospedagem de revenda.
1. No GiroStock (Master) → empresa J&A: ligar os módulos (Eventos e, quando for testar, Nota fiscal) e, em
   **"Eventos · agenda no site"**, ativar e gerar a chave (`ag_...`).
2. Copiar `docs/agenda-site/proximos-eventos.php` do repositório para o site (ex.: `includes/proximos-eventos.php`) e
   colocar a chave no lugar indicado no topo do arquivo.
3. No `index.php` do site, seção `#eventos`, dentro de `<div class="events__panel">`, trocar o bloco
   `<div class="events__empty">...</div>` por `<?php include __DIR__ . '/includes/proximos-eventos.php'; ?>`.
   (Instruções completas no cabeçalho do arquivo.) Fazer backup do `index.php` antes.
4. Conferir: cadastrar um evento "Divulgar no site" (e com pop-up) e abrir o site.

### 6. Depois do PHP ok: primeiro teste real da nota fiscal na J&A (homologação)
Não é configuração de servidor, é dentro do sistema (guia em `docs/nota-fiscal.md`):
- Master → J&A → ligar "Nota fiscal (NFC-e)".
- Nota fiscal → Configuração da loja: dados fiscais (em **Teste/homologação**), certificado A1 (.pfx + senha, o usuário
  envia), CSC de teste gerado no site da Receita/PR, "Testar conexão com a SEFAZ".
- Produtos (NCM) e Perfis fiscais (conferir com o contador). Vendas de teste no PDV com "Cupom fiscal (NFC-e)".
- Até aqui os testes foram com a resposta da SEFAZ **simulada**; este é o primeiro envio real.

## Ao terminar
Anotar o que foi feito e o que ficou pendente (ex.: extensão que o suporte precisa habilitar) e avisar o usuário.

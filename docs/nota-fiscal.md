# Nota fiscal (NFC-e) no GiroStock

O GiroStock emite a NFC-e (cupom fiscal eletrônico, modelo 65) **direto na SEFAZ**, sem empresa intermediária e sem custo
por nota. Quem monta, assina e envia a nota é o motor PHP em `backend/fiscal/motor.php` (biblioteca livre NFePHP).

## Para o cliente (passo a passo)

1. **Master → empresa → módulos**: ligar “Nota fiscal (NFC-e)” (vem desligado).
2. **Nota fiscal → Configuração da loja**: dados do cartão CNPJ e da inscrição estadual, regime (Simples Nacional),
   endereço com o código IBGE da cidade (Curitiba = 4106902) e o modo do PDV:
   - *O caixa escolhe*: no pagamento aparecem “Cupom fiscal (NFC-e)” e “Só cupom”;
   - *Sempre cupom fiscal*;
   - *Desligado*: só o cupom não fiscal de sempre.
3. **Certificado digital A1** (.pfx/.p12 + senha). Fica cifrado no banco. O sistema confere a senha, a validade e se o
   CNPJ do certificado é o da loja.
4. **CSC** (código de segurança do contribuinte): gerado no site da Receita Estadual (Paraná: Receita/PR → NFC-e → CSC).
   Há um CSC para teste (homologação) e outro para produção.
5. **Perfis fiscais**: a tributação definida pelo contador (CFOP, CSOSN, origem, PIS/COFINS). Para o Simples, o botão
   “Criar os perfis mais comuns” cria *Mercadoria em geral* (5102/102, padrão) e *Bebida/cigarro com ST* (5405/500).
   Cada produto usa o perfil dele, senão o da categoria, senão o padrão.
6. **Produtos (NCM)**: todo produto vendido com nota precisa do NCM (8 números). Ao importar o XML de uma nota de compra,
   o NCM e o CEST são preenchidos sozinhos nos produtos que ainda não têm.
7. Fazer vendas de **teste** (ambiente homologação): a nota sai “EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO – SEM VALOR FISCAL”.
8. Com tudo conferido com o contador: mudar para **Produção** (pede confirmação) e informar o CSC de produção.
   A numeração de produção é separada da de teste.

## Como funciona

- A venda é gravada normalmente; se o caixa escolheu “Cupom fiscal”, o PDV pede a NFC-e da venda logo depois
  (`POST /api/fiscal/nfce`) e o cupom impresso já sai como DANFE NFC-e (chave, protocolo e QR Code).
- Desconto e taxas são rateados nos itens; o total da nota fecha com o da venda. Troco e CPF (opcional) vão na nota.
- **Sem internet com a SEFAZ**: a nota sai em contingência offline (tpEmis 9), com QR Code, e o servidor envia sozinho
  a cada 2 minutos (`FISCAL_VARREDURA_SEGUNDOS`). Em *Nota fiscal → Notas* dá para “Enviar agora”.
- **Rejeitada** (ex.: NCM errado): corrigir o cadastro e clicar em “Reenviar” (mesmo número).
- **Cancelar**: em *Notas*, com a permissão “Cancelar vendas”, justificativa de 15+ letras. No Paraná a SEFAZ aceita até
  30 minutos depois da autorização. Cancelar a nota não cancela a venda.
- Produto sem NCM ou sem perfil: a nota é recusada **antes** de gastar um número.

## Servidor (cPanel)

- PHP 8.1 ou mais novo, em linha de comando, com as extensões `curl dom json libxml mbstring openssl simplexml zlib`.
- As dependências PHP (`backend/fiscal/vendor`) vêm prontas na branch `producao` (o GitHub Actions roda o composer).
- Se o comando `php` do servidor não for o PHP 8.1+, defina no app Node a variável `FISCAL_PHP` com o caminho certo
  (ex.: `/opt/cpanel/ea-php83/root/usr/bin/php`).
- Conferir: `echo '{"acao":"diagnostico"}' | php backend/fiscal/motor.php` → `{"ok":true,...}`.
- Opcional: responsável técnico na nota (`FISCAL_RESP_TEC_CNPJ`, `FISCAL_RESP_TEC_CONTATO`, `FISCAL_RESP_TEC_EMAIL`,
  `FISCAL_RESP_TEC_FONE`).
- Testes: `FISCAL_SIMULADOR=1` monta, assina e valida a nota de verdade mas não envia à SEFAZ;
  `npm run test:e2e:fiscal` (47 checagens).

## Ainda não faz (próximas etapas)

- NF-e modelo 55 (venda para CNPJ), inutilização de números pulados, carta de correção.
- Exportação do lote de XML do mês para o contador (hoje: XML nota a nota).
- Reforma tributária (IBS/CBS): ainda não obrigatória para o Simples Nacional.

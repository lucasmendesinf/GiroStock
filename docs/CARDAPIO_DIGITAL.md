# Cardápio digital para o cliente final

Modelo de loja do tipo **cardápio** (`lv_lojas.tipo = 'cardapio'`): uma página só (capa, perfil da loja e todos os produtos numa rolagem contínua),
barra de categorias fixa que acompanha a rolagem, entrega ou retirada, pagamento online ou na entrega e login por telefone. O varejo (`tipo = 'varejo'`)
não muda. Site em `loja/` (`paginas/Cardapio.jsx`), API em `/api/loja/v1` (`GET /cardapio`, `POST /conta/codigo`, `POST /conta/entrar`).

## Login por telefone e código

O cliente informa o celular, recebe um código de 6 números (vale 10 minutos, 3 tentativas, uso único) e entra, sem senha. Só o hash do código é guardado
(`lv_login_codigos`). O envio é feito por `backend/src/services/codigoLogin.js`, escolhido por variável de ambiente no servidor (nada de segredo no código):

| Variável | Para que serve |
|---|---|
| `CODIGO_LOGIN_PROVEDOR` | `simulado` (padrão fora da produção: não envia, o código aparece no console e na resposta da API) ou `http`. **Em produção `simulado` é recusado** (o login por telefone fica indisponível e o painel Master mostra o motivo). |
| `CODIGO_LOGIN_HTTP_URL` | Endereço da API de WhatsApp/SMS contratada (provedor `http`). Pode ter `{telefone}` e `{mensagem}` (usado no método GET). |
| `CODIGO_LOGIN_HTTP_METODO` | `POST` (padrão) ou `GET`. |
| `CODIGO_LOGIN_HTTP_CABECALHO` e `CODIGO_LOGIN_HTTP_TOKEN` | Cabeçalho de autenticação (ex.: `Authorization` e `Bearer xxxx`). |
| `CODIGO_LOGIN_HTTP_CORPO` | Corpo JSON com `{telefone}` (já com `55`) e `{mensagem}`. Padrão: `{"telefone":"{telefone}","mensagem":"{mensagem}"}`. |
| `CODIGO_LOGIN_MENSAGEM` | Texto com `{loja}` e `{codigo}`. Padrão: `Seu código de acesso à *{loja}* é *{codigo}*. Vale por 10 minutos.` |

O status do provedor (sem segredos) aparece em **Master › Configurações globais › Integrações**. Falha no envio devolve 502 ("não foi possível enviar o código;
tente de novo") sem contar no limite do telefone e sem gravar o código no log. O custo por mensagem é do lojista/plataforma.

## Formas de pagamento

- **Online (Mercado Pago):** Pix e cartão de crédito. **Cartão de débito online não é oferecido**: o fluxo atual (token do cartão no Mercado Pago) é de crédito;
  o débito exigiria outro meio de pagamento/aprovação do provedor. `debito_online` fica sempre desligado (a API recusa ligá-lo) e o débito é aceito **na entrega
  ou na retirada**, na maquininha. `orders.pagamento_online` já aceita `'debito'` para quando o provedor permitir.
- **Na entrega/retirada:** dinheiro (com `troco_para` ≥ total), cartão de crédito, cartão de débito e Pix, cada um ligado/desligado pela loja em
  Loja virtual › Pagamentos. A lista antiga com `cartao` foi convertida para crédito + débito.
- Na tela **Pedidos**, o pedido fica "a receber" com a forma e o troco; ao finalizar, a forma escolhida pelo cliente já vem selecionada. Pedido pago online segue
  gerando a venda sem caixa.

## Gestão

Loja virtual › Aparência (loja do tipo cardápio): capa, estilo dos cartões (foto à esquerda, à direita ou grade de 2 colunas), selo "% OFF" e categoria
automática "Promoções".

## Testes

`npm run test:e2e:cardapio` (com `npm run mp:simulador` e a API com `MP_API_URL=http://localhost:4997`; sem o simulador, os testes de pagamento online são pulados).
`CARDAPIO_E2E_GRANDE=1` deixa ~200 itens publicados para medir a rolagem no navegador e `CARDAPIO_E2E_LIMPAR=1` despublica os itens de teste.

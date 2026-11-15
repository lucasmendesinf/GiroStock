# WhatsApp (API oficial da Meta) no GiroStock

Etapa 1 (pronta): cada empresa conecta o WhatsApp Business dela e o sistema avisa o cliente de cada etapa do pedido.
O número **continua no WhatsApp Business do celular** (coexistência). Sem intermediário: o GiroStock fala direto com a
WhatsApp Cloud API da Meta; a Meta cobra as mensagens da conta da empresa.

## O que o cliente final recebe

| Etapa do pedido | Aviso (modelo) | Padrão |
|---|---|---|
| Pedido criado (pago no site: depois do pagamento aprovado) | Pedido recebido (nº, loja e total) | ligado |
| Em preparo | Em preparo | ligado |
| Pronto (só retirada) | Pronto para retirar | ligado |
| Saiu para entrega | Saiu para entrega com o nome do entregador | ligado |
| Finalizado (entrega) | Entregue | desligado |
| Cancelado (só se o cliente já tinha recebido algum aviso) | Cancelado | ligado |

- Vale para pedidos do site/cardápio digital e para os lançados no sistema com o celular do cliente (telefone, WhatsApp,
  balcão). **iFood e 99Food não recebem** (a plataforma avisa). Mesa/comanda também não.
- Cada mudança de status avisa uma vez só. A situação (enviada, entregue, lida ✓✓, falhou) aparece em **WhatsApp →
  Últimas mensagens** e na gaveta do pedido (**WhatsApp do cliente**).
- Os 6 modelos (categoria **utilidade**, pt_BR, nomes `girostock_pedido_*`) são criados na conta da empresa ao conectar;
  a Meta aprova em minutos (botão *Atualizar modelos*; o servidor também confere a cada 10 min).

## Configuração na Meta (Calutec, uma vez só)

1. **Gerenciador de Negócios** (business.facebook.com) da Calutec com a empresa **verificada** (CNPJ).
2. **developers.facebook.com → Criar app** → tipo *Empresa* → adicionar o produto **WhatsApp**.
3. Em *WhatsApp → Configuração*: **Webhook**
   - URL de retorno: `https://girostock.calutec.com.br/api/webhooks/whatsapp`
   - Token de verificação: um texto que você inventa (vai na variável `WHATSAPP_VERIFY_TOKEN`)
   - Assinar o campo **messages**.
4. **Cadastro incorporado (Embedded Signup)**: *Facebook Login para Empresas → Configurações → Criar configuração*,
   tipo *WhatsApp Embedded Signup*, com as permissões `whatsapp_business_management` e `whatsapp_business_messaging`.
   Anote o **ID da configuração** (`WHATSAPP_CONFIG_ID`).
5. Em *Facebook Login para Empresas → Configurações*: domínios permitidos `girostock.calutec.com.br` (e o SDK do
   JavaScript ligado).
6. Para atender várias empresas clientes: cadastrar a Calutec como **Provedor de Tecnologia** (Tech Provider) e passar
   pela **análise do app** (App Review) com as duas permissões acima. Até a aprovação, só contas com papel no app
   conseguem conectar (dá para testar com a própria J&A).

## Variáveis do servidor (Setup Node.js App)

| Variável | O quê |
|---|---|
| `WHATSAPP_APP_ID` | ID do app (painel do app na Meta) |
| `WHATSAPP_APP_SECRET` | Chave secreta do app (*Configurações → Básico*). **Quem digita é o administrador, no painel.** |
| `WHATSAPP_CONFIG_ID` | ID da configuração do cadastro incorporado |
| `WHATSAPP_VERIFY_TOKEN` | O mesmo texto do passo 3 |
| `WHATSAPP_GRAPH_VERSAO` | Opcional (padrão `v23.0`) |

Depois: Master → empresa → ligar o módulo **WhatsApp (API oficial)** → na empresa, menu **WhatsApp → Conectar WhatsApp**.

## Conectar (empresa cliente)

1. O número precisa estar no app **WhatsApp Business** atualizado (não no WhatsApp comum).
2. **WhatsApp → Conectar WhatsApp**: abre a janela da Meta; entrar com o Facebook, escolher/criar a empresa e escolher
   *conectar o WhatsApp Business do celular*; no celular, ler o QR Code (WhatsApp Business → Configurações →
   Dispositivos conectados).
3. Pronto: a tela mostra o número, os modelos (aprovados em minutos) e os avisos para ligar/desligar. *Enviar teste*
   manda o aviso de exemplo para um celular.
- Com a coexistência, abra o WhatsApp Business no celular pelo menos a cada 14 dias (regra da Meta).
- Token expirado/revogado: a tela pede **Reconectar**.

## Testes

Servidor de testes: `WHATSAPP_SIMULADOR=1`, `WHATSAPP_GRAPH_URL=http://localhost:4994` e as variáveis acima com qualquer valor
(o segredo igual ao `SIM_APP_SECRET` do simulador), `node scripts/whatsapp-simulador.mjs` e `npm run test:e2e:whatsapp`
(39 verificações: conexão, modelos, teste, webhook e assinatura, cada etapa do pedido, regras, permissões, desconectar).

## Próximas etapas

2. Receber mensagens: resposta automática com o link do cardápio digital; código de acesso da loja virtual pelo WhatsApp.
3. Campanhas de cupom para os segmentos de clientes (modelos de marketing, com consentimento do cliente).

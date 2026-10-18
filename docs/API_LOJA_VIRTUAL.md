# API da Loja Virtual (v1)

API pública que o **site da loja** usa para falar com o GiroStock. O site é um projeto separado, **o mesmo para todas as empresas**: só o layout (tema) muda de cliente para cliente. Toda a regra (preço, estoque, entrega, cupom, pagamento) fica no GiroStock.

- **Endereço:** `https://<servidor-do-girostock>/api/loja/v1`
- **Formato:** JSON (UTF-8). Valores em reais com 2 casas (`12.5` = R$ 12,50). Datas em ISO 8601.
- **Erros:** status HTTP + `{ "erro": "mensagem em português, pronta para mostrar ao cliente" }`.

| Status | Quando |
|---|---|
| 400 | dado inválido (campo faltando, formato errado) |
| 401 | chave da loja ausente/errada, ou token do cliente ausente/expirado |
| 403 | módulo Loja virtual desligado para a empresa (ou empresa suspensa) |
| 404 | produto/pedido/endereço não encontrado |
| 409 | conflito: loja fechada/pausada, sem estoque, pedido já em preparo, e-mail já cadastrado |
| 422 | regra de negócio: cupom inválido, bairro sem entrega, pedido mínimo, forma de pagamento não aceita |
| 429 | muitas tentativas (login, cadastro, recuperação de senha) |
| 502 | o Mercado Pago recusou/falhou ao gerar a cobrança |

## Autenticação

1. **Chave da loja** — cabeçalho `X-Loja-Chave: lv_...` em **todas** as chamadas (menos `/imagens`). É gerada em *Loja virtual → Visão geral → Ligação com o site* e identifica a empresa. Gerar uma nova chave desativa a anterior na hora.
2. **Token do cliente** — `Authorization: Bearer <token>` nas rotas de conta e pedidos. Vem do cadastro, login ou redefinição de senha. Vale 30 dias; trocar/redefinir a senha encerra as outras sessões; conta bloqueada pela loja perde o acesso na hora (401).

> A chave identifica a loja, não dá acesso a dados de clientes: tudo o que é do cliente exige o token dele. Preços e totais são sempre recalculados no servidor.

## Loja e catálogo

### `GET /loja`
Dados para montar o site.
```json
{
  "nome": "Lanchonete JA", "descricao": "...", "logo": "https://.../api/loja/v1/imagens/<id>",
  "banners": [{ "imagem": "https://...", "titulo": "", "link": "" }],
  "contato": { "telefone": "", "whatsapp": "11999990000", "email": "", "endereco": "", "instagram": "" },
  "aviso": "Entregas até as 23h",
  "no_ar": true, "recebendo_pedidos": false, "motivo_fechada": "a loja está fechada: abre amanhã às 18:00",
  "horario": { "aberta": false, "sempre_aberta": false, "fecha_as": null, "proxima_abertura": { "dia": "amanhã", "dia_semana": 5, "hora": "18:00" } },
  "horarios": { "5": [{ "de": "18:00", "ate": "02:00" }] },
  "retirada": { "aceita": true, "tempo_estimado_min": 20 },
  "entrega": {
    "aceita": true, "tempo_estimado_min": 50,
    "bairros": [{ "id": "...", "nome": "Centro", "taxa": 5, "tempo_estimado_min": 50, "pedido_minimo": null }],
    "outros_bairros": { "taxa": 12 }
  },
  "pedido_minimo": 0,
  "pagamentos": { "pix_online": true, "cartao_online": true, "na_entrega": ["dinheiro", "pix", "cartao"], "parcelas_max": 3, "mercadopago_public_key": "APP_USR-..." }
}
```
- `no_ar: false` → mostrar página de loja fora do ar. `recebendo_pedidos: false` → navegação liberada, finalização bloqueada (mostrar `motivo_fechada`).
- `horarios`: chave = dia da semana (0 = domingo). `ate` menor que `de` = passa da meia-noite. Vazio = sempre aberta.
- `entrega.outros_bairros: null` → só entrega nos bairros da lista.

### `GET /categorias`
`[{ "id", "nome", "pai_id", "produtos" }]` — só categorias com produto publicado (as categorias-pai somam as filhas).

### `GET /produtos`
Parâmetros: `categoria` (id; inclui as subcategorias), `busca`, `destaque=1`, `ordem` (`nome` | `menor_preco` | `maior_preco`; padrão: destaques primeiro), `pagina`, `por_pagina` (até 100, padrão 24).
```json
{ "pagina": 1, "por_pagina": 24, "total": 2, "paginas": 1, "produtos": [ {
  "id": "...", "nome": "Refrigerante lata", "descricao": "Lata 350 ml", "unidade": "UN",
  "categoria": { "id": "...", "nome": "Bebidas", "pai": null },
  "preco": 5, "preco_original": 6, "promocao_ate": "2026-10-23",
  "imagens": ["https://.../api/loja/v1/imagens/<id>"], "destaque": true,
  "disponivel": true, "quantidade_maxima": 18,
  "complementos": [{ "id": "...", "nome": "Adicionais", "minimo": 0, "maximo": 2, "opcoes": [{ "id": "...", "nome": "Bacon extra", "preco": 3 }] }]
} ] }
```
- `preco_original` só vem com promoção válida hoje (mostrar "de R$ 6,00 por R$ 5,00").
- `disponivel`/`quantidade_maxima` (até 99) já descontam os pedidos em aberto. Lanche com ficha técnica é calculado pelos insumos.
- `complementos`: grupos do produto. O cliente escolhe entre `minimo` e `maximo` opções no grupo (somando as quantidades); o preço das opções soma ao preço unitário.

### `GET /produtos/:id` — o mesmo objeto de produto.

### `GET /imagens/:id` — a foto (sem chave; cache longo, pode ser usada direto em `<img>`).

## Carrinho

### `POST /carrinho` (token opcional)
Prévia com os preços e regras atuais. Problemas que o cliente resolve viram `avisos` (o carrinho não dá erro).
```json
{ "itens": [ { "product_id": "...", "quantidade": 2 },
             { "product_id": "...", "quantidade": 1, "complementos": [{ "id": "...", "quantidade": 2 }], "observacao": "sem cebola" } ],
  "tipo": "entrega", "endereco_id": "...", "cupom": "PROMO10" }
```
Em vez de `endereco_id` (cliente logado) dá para mandar `"bairro": "Centro"` (visitante). Resposta:
```json
{ "itens": [{ "product_id", "nome", "quantidade", "preco_unitario", "preco_base", "preco_original", "complementos": [...], "observacao", "subtotal" }],
  "subtotal": 34, "taxa_entrega": 5, "desconto": 3.4, "total": 35.6,
  "cupom": { "id": "...", "codigo": "PROMO10", "descricao": "", "tipo": "percentual", "valido": true, "motivo": null },
  "entrega": { "tipo": "entrega", "taxa": 5, "bairro": "Jardim América", "regiao_id": "...", "tempo_estimado_min": 50 },
  "pedido_minimo": 0, "avisos": [], "pode_finalizar": true }
```
- Cupom inválido: `cupom.valido = false` com `motivo` (vencido, já usado, só primeira compra, entre na conta...).
- Erros 422 só para carrinho impossível (complemento fora das regras do grupo, produto que saiu do site).

## Conta do cliente

| Método e rota | Corpo | Resposta |
|---|---|---|
| `POST /conta/cadastro` | `nome, email, telefone, senha, cpf?, aceita_mensagens?` | `201 { token, conta }` |
| `POST /conta/login` | `email, senha` | `{ token, conta }` |
| `POST /conta/esqueci-senha` | `email` | `202` (mesma resposta exista ou não a conta; envia código de 6 dígitos por e-mail, vale 15 min) |
| `POST /conta/redefinir-senha` | `email, codigo, senha` | `{ token, conta }` (encerra as outras sessões) |
| `GET /conta` | — | `conta` |
| `PUT /conta` | `nome?, telefone?, cpf?, aceita_mensagens?` | `conta` |
| `PUT /conta/senha` | `senha_atual, nova_senha` | `{ token }` (novo; os outros param de valer) |
| `DELETE /conta` | `senha` | `204` — apaga os dados pessoais (LGPD); os pedidos ficam no histórico da loja |

- Senha: mínimo 8 caracteres, com letras e números. Telefone com DDD (10 ou 11 dígitos). CPF validado (opcional; ajuda no pagamento).
- `conta = { id, nome, email, telefone, cpf, aceita_mensagens, criado_em }`.
- A conta é ligada ao cadastro de **Clientes** do sistema pelo telefone.

### Endereços
`GET /conta/enderecos` · `POST /conta/enderecos` · `PUT /conta/enderecos/:id` · `DELETE /conta/enderecos/:id`
```json
{ "rotulo": "Casa", "cep": "01310100", "logradouro": "Rua das Flores", "numero": "100", "complemento": "apto 12",
  "bairro": "Jardim América", "cidade": "São Paulo", "uf": "SP", "referencia": "portão azul", "padrao": true }
```
Obrigatórios: `logradouro`, `numero` (ou "s/n"), `bairro`. O primeiro endereço vira o padrão. A taxa de entrega é escolhida pelo **bairro** (sem diferenciar acento/maiúsculas).

## Pedidos

### `POST /pedidos` (token)
```json
{ "itens": [ ...como no carrinho... ], "tipo": "entrega", "endereco_id": "...", "cupom": "PROMO10", "observacao": "tocar o interfone",
  "pagamento": { "metodo": "na_entrega", "forma": "dinheiro", "troco_para": 50 } }
```
`pagamento.metodo`:
- `"na_entrega"` + `forma`: `"dinheiro"` (com `troco_para` opcional, ≥ total), `"pix"` ou `"cartao"` — conforme `GET /loja → pagamentos.na_entrega`.
- `"pix"` — gera o Pix no Mercado Pago. A resposta traz `pagamento.detalhe.pix` com `copia_e_cola`, `qr_code_base64` (PNG) e `expira_em`.
- `"cartao"` + `cartao`: `{ "token", "payment_method_id", "issuer_id", "parcelas", "identificacao": { "tipo": "CPF", "numero" } }`. O `token` é gerado **no navegador** pelo Mercado Pago JS / Card Payment Brick com `pagamentos.mercadopago_public_key` — o número do cartão nunca passa pelo site nem pelo GiroStock. Até `parcelas_max` parcelas.

Responde `201` com o **pedido** (abaixo). Falta de estoque, loja fechada, cupom ou mínimo inválidos recusam o pedido (409/422). Se o Mercado Pago falhar, o pedido é cancelado e volta `502` — o cliente pode tentar de novo.

### `GET /pedidos?pagina=1` (token) — histórico do cliente: `{ pagina, total, pedidos: [{ id, numero, etapa, etapa_nome, tipo, itens, total, criado_em }] }`

### `GET /pedidos/:id` (token) — acompanhamento (consultar a cada 15–30 s na tela do pedido)
```json
{ "id": "...", "numero": 12, "etapa": "aguardando_pagamento", "etapa_nome": "Aguardando pagamento", "tipo": "entrega",
  "endereco": "Rua das Flores, 100 - apto 12 - Jardim América, São Paulo/SP (Ref.: portão azul)",
  "itens": [{ "product_id", "nome", "quantidade", "preco_unitario", "subtotal", "observacao", "complementos": [{ "nome", "quantidade", "preco" }], "imagem" }],
  "subtotal": 34, "taxa_entrega": 5, "desconto": 3.4, "total": 35.6, "cupom": "PROMO10", "observacao": "...",
  "pagamento": { "tipo": "online", "metodo": "pix", "situacao": "pendente",
                 "detalhe": { "id", "metodo", "situacao", "valor", "parcelas", "bandeira", "final_cartao", "motivo_recusa", "pix": { "copia_e_cola", "qr_code_base64", "expira_em" }, "aprovado_em", "criado_em" } },
  "historico": [{ "etapa": "recebido", "em": "..." }],
  "criado_em": "...", "previsao_min": 50, "cancelado_em": null, "motivo_cancelamento": null,
  "pode_cancelar": true, "pode_pagar": true }
```
Pagamento na entrega: `pagamento = { "tipo": "na_entrega", "forma": "dinheiro", "troco_para": 50, "situacao": "a_pagar" | "pago" }`.

**Etapas:** `aguardando_pagamento` → `recebido` → `em_preparo` → `pronto` (entrega: aguardando o entregador) / `pronto_retirada` → `saiu_entrega` → `entregue` / `retirado`; ou `cancelado`.

**Situação do pagamento online:** `pendente`, `aprovado`, `recusado` (cartão; ver `motivo_recusa`), `expirado` (Pix não pago no prazo), `estornado`.

### `POST /pedidos/:id/pagamento` (token)
Nova tentativa (Pix expirado ou cartão recusado) enquanto `pode_pagar`: `{ "metodo": "pix" }` ou `{ "metodo": "cartao", "cartao": { ... } }`.

### `POST /pedidos/:id/cancelar` (token)
`{ "motivo": "..." }` — só enquanto `pode_cancelar` (antes do preparo). Pago pelo site: o valor é estornado no Mercado Pago.

## Regras que valem para o site

- **Pix:** sem pagamento no prazo configurado pela loja, o pedido é cancelado sozinho e o estoque volta. Pix pago depois do cancelamento é estornado automaticamente.
- **Pago no site:** a loja só começa o preparo depois do pagamento aprovado.
- **Cancelamento pela loja** de pedido pago pelo site: estorno automático.
- O dinheiro dos pagamentos online cai direto na conta do Mercado Pago **da própria empresa** (credenciais em *Loja virtual → Pagamentos*). Os avisos de pagamento chegam em `POST /api/webhooks/mercadopago/<id-da-loja>` (endereço mostrado na tela).

## Teste local

```
cd backend
npm run mp:simulador            # Mercado Pago simulado na porta 4997
# .env: MP_API_URL=http://localhost:4997  LOJA_VARREDURA_SEGUNDOS=2
npm run test:e2e:loja-virtual   # banco recém-criado (migrate + seed)
```
No simulador, o token do cartão decide o resultado: `cartao-aprovado`, `cartao-recusado`, `cartao-analise`. Sem SMTP fora da produção, os e-mails de recuperação de senha são gravados em `backend/tmp/emails/`.

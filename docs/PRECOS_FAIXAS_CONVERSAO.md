# Preço por loja, desconto por quantidade e produto que vira insumo

Três recursos no cadastro do produto (migration `047_precos_faixas_conversao.sql`):

1. **Preço de venda por loja**: a mesma mercadoria custa um preço na Distribuidora e outro na Casa de show; "não vende nesta loja" tira o produto daquela loja.
2. **Desconto por quantidade** (pack, fardo, atacado), por loja ou para todas.
3. **Produto que vira insumo na transferência**: o óleo de 1 L vendido inteiro na distribuidora vira 1.000 ML de insumo ao ser transferido para a lanchonete.

O custo é **um só** por produto (`products.preco_custo`); só o preço de venda varia por loja. A margem é calculada por loja.

## Preço por loja

- `produto_precos (product_id, location_id, preco_venda NULL, vende)`. Sem linha = herda `products.preco_venda` e vende.
- `vende = false`: o produto **não aparece** no PDV, nos pedidos e no app do garçom da loja, e a venda/pedido direto pela API é recusada (400).
- O **preço enviado pelo cliente é ignorado**: o servidor calcula (`services/precos.js`). iFood/99Food e loja virtual continuam com o preço deles.

## Desconto por quantidade (faixas)

- Valem só para o **mesmo produto** (sem mistura) e só dentro de **um documento**: a venda do PDV, o pedido ou a **rodada** da comanda. Nunca somam entre rodadas; o fechamento da comanda repete os preços das rodadas.
- Cada faixa é **automática** (o sistema aplica ao atingir a quantidade) ou **manual** (só com `faixa_id` no item). Havendo as duas elegíveis, vale a de **menor preço unitário** (nunca empilha).
- Aplicada a faixa, **todas** as unidades pagam o preço dela (8 un com faixa de 6 = 8 × preço do pack).
- Se a loja tem faixas próprias, elas **substituem** as gerais (`location_id` nulo) naquela loja. Combos não têm faixa (aceitam preço por loja).
- Como informar: **preço por unidade**, **preço do kit** (precisa dividir em centavos exatos: R$ 48,00 ÷ 6 = 8,00; R$ 50,00 ÷ 6 é recusado) ou **% de desconto** (arredonda para centavos).
- Validações: preço da faixa menor que o unitário; quantidades mínimas inteiras (≥ 2) e distintas; preços decrescentes conforme a quantidade cresce. **Alerta** (não bloqueia) se a faixa está no custo ou abaixo, ou com margem menor que 10%.
- **EAN do pack** (8 a 14 números): único na empresa e diferente de qualquer código de barras de produto. Ler o EAN do pack no PDV lança a quantidade da faixa.
- `sale_items` e `order_items` guardam `preco_tabela` (preço da loja antes da faixa, com complementos) e `faixa_rotulo` (nulos sem faixa). O resumo de vendas mostra `desconto_por_quantidade` = Σ (preço de tabela − cobrado) × quantidade.
- O valor do estoque a preço de venda (relatório de estoque) usa o preço **da loja** do saldo.

## Produto que vira insumo na transferência

- Cadastro do produto → "Pode virar insumo na transferência": insumo existente ou **criado a partir do produto**, fator (1 L = 1.000 ML), lojas em que vira insumo e modo **perguntar** (padrão) ou **sempre**.
- Compatibilidade de unidades: L → ML/L; KG → G/KG; UN → UN/Fatia/G/ML; CX → UN/Fatia/G/ML/KG/L. Produto com ficha técnica ou combo não converte; o insumo não pode estar na ficha do próprio produto. Só com o módulo Lanchonete.
- `POST /stock-movements` (`tipo: 'transferencia'`): se o destino está marcado, o corpo traz `converter_em_insumo`. Modo `perguntar` sem ele → 400; `false` mantém como produto; modo `sempre` converte e `false` é recusado (400). Destino não marcado: transferência comum (e `true` é recusado).
- Ao converter, na mesma transação: baixa o produto na origem (ele **não chega** ao destino), soma `quantidade × fator` no insumo do destino e define o custo do insumo = custo do produto ÷ fator. Os dois lados ficam ligados pelo id do movimento (`stock_movements.conversao_*` e a auditoria `entrada_conversao`) e aparecem no histórico como "Transferência com conversão em insumo". Não existe "desconverter" (correção por balanço).
- `GET /stock-movements/conversao?product_id=&location_destino_id=&quantidade=` dá a prévia (não grava) para a tela de transferência.

## API

- `GET /products/:id` → `precos_lojas` (por loja: preço próprio ou herdado, `vende`, margem), `faixas` e `conversao`.
- `PUT /products/:id` e `POST /products` aceitam `precos_lojas`, `faixas` e `conversao` (`null` remove) numa transação, com auditoria antes/depois. Exige a permissão `EditarProdutos`.
- `GET /products/search` (com `terminal_id`/`location_id`): preço da loja, produto que a loja não vende não aparece, `faixas` elegíveis e, na leitura do EAN de pack, `quantidade_pack` e `faixa_pack_id`.
- `POST /sales`, `POST /orders` e as rodadas aceitam `itens[].faixa_id` (faixa manual).

## Testes

```bash
npm run test:unit:precos    # regras puras (sem banco)
npm run test:e2e:precos     # API em http://localhost:3000, banco com migrations e seed
```

## Desvios do desenho original (prompt)

- **Custo do insumo**: o desenho dizia "custo médio ponderado". O sistema usa, em toda entrada de insumo, o **custo da última entrada** (e recalcula o custo dos produtos com receita); a conversão segue a mesma regra: custo do produto ÷ fator.
- **Saldo insuficiente na transferência**: devolve **400** (como já era), não 409.
- **Faixa manual** só no PDV (botão "Aplicar <faixa>", que envia `faixa_id`); no app do garçom e no formulário de pedidos a prévia mostra só as faixas automáticas (o servidor também só aplica a manual com `faixa_id`).
- **Preço por loja no site (loja virtual)**: continua com o preço base e as promoções atuais, como decidido no desenho.

# Prompt — Preço por loja, desconto por quantidade (pack/atacado) e produto que vira insumo na transferência

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Modelo visual **validado pelo cliente**: `docs/precos-preview/preview-produto-precos.html` (3 abas: **Cadastro do produto**, **Transferência**, **PDV**). Sirva e clique em tudo:
> ```bash
> cd docs/precos-preview && npx --yes serve -l 8091 .      # ou: python -m http.server 8091
> ```
> O preview parte da tela de cadastro de produto de hoje; as seções com a etiqueta **NOVO** são a proposta.

---

## 1. Objetivo

Três recursos no produto:

1. **Preço de venda por loja** (a mesma mercadoria custa um preço na Distribuidora e outro na Casa de show; "não vende nesta loja" tira o produto daquela loja).
2. **Desconto por quantidade** (pack fechado / atacado), configurado **por loja**: ex. Monster avulsa R$ 9,50; a partir de 6 un, R$ 8,00 cada (kit R$ 48,00); a partir de 24, R$ 7,20.
3. **Produto que vira insumo na transferência**: o óleo de 1 L vendido inteiro na distribuidora vira **1.000 ML de insumo** ao ser transferido para a lanchonete, onde é usado por medida nas receitas.

Decisões já tomadas pelo cliente (não rediscutir):
- O desconto por quantidade vale **somente para o mesmo produto** (pack fechado). **Sem mistura** de produtos.
- **Cada faixa escolhe**: **automática** (o sistema aplica ao atingir a quantidade) ou **manual** (só se o operador escolher aplicar o pack).
- Vale para **todos os clientes** (sem tabela de preço por cliente por enquanto).
- O **custo é um só** por produto (a mercadoria entra na loja central, a Distribuidora); **só o preço de venda** varia por loja. A margem é calculada **por loja** em cima do custo único.
- Conversão em insumo: o sistema **pergunta** ao transferir (converter ou manter como produto). (O modo "converter sempre" também existe na configuração, mas o padrão do cadastro é **perguntar**.)

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador (incluindo 375 px nas telas tocadas) e por requisições reais; build não basta.
- Antes de criar migrations: `ls backend/src/db/migrations` e use o **próximo número livre** (a última conhecida é `035_grades_variacoes.sql`; outras sessões podem ter criado mais).
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Dinheiro**: arredonde sempre em **centavos**, de forma explícita e testada (nada de ponto flutuante solto).
- **Não quebre** vendas, PDV, caixa, pedidos, garçom/comandas/comissões, financeiro, relatórios, estoque, insumos, grades, loja virtual, iFood/99Food, Master, modo teste. Rode as suítes `backend/scripts/e2e-*.mjs` (cada uma em banco recém-criado) e **compare com o que passava antes**.
- Permissões: use a permissão de editar produtos (`EditarProdutos`) se ela já existir (prompt `docs/prompt-permissoes-edicao.md`); senão `Estoque`. Quem só **vende** nunca edita preços.
- Estilo: paleta atual, temas claro e escuro. Toda consulta filtra por `tenant_id` e respeita lojas (`assertLocationAccess`/`filtroLocais`).

## 3. Estado atual (leia antes; confirme no código)

- **Preço de venda é um só**: `products.preco_venda` (e `preco_custo`). Lido em `services/vendas.js` (~linha 150: `preco = preco_venda + complementos`; `sale_items.preco_unitario`/`custo_unitario`), `services/consumo.js` (carrega produtos), `services/pedidos.js` (pedidos/rodadas), `routes/products.routes.js` (`GET /products`, `GET /products/search` usado pelo PDV, criar/editar), `routes/stock.routes.js`, `services/grades.js` (variações), `routes/lojaVirtual.routes.js` (promoção e site), `routes/reports.routes.js` (valor de estoque a preço de venda). Plataformas (iFood/99Food) mandam o preço (`precos_informados`) e **não** devem ser afetadas.
- **Transferência de produto**: `POST /stock-movements` com `tipo: 'transferencia'` (`routes/stock.routes.js`), saldos em `stock_balances` por loja; telas em `frontend/src/pages/produtos/EstoqueProduto.jsx` (`TelaTransferencia`) e `Movimentacoes.jsx`. **Insumos**: `ingredients`, `ingredient_balances` por loja, entradas com **custo médio ponderado** (`routes/ingredients.routes.js`, `…/stock-entries`), consumo por ficha técnica (`services/consumo.js`). Unidades: produto `UN, KG, L, CX`; insumo `G, KG, ML, L, UN, Fatia` (`pages/produtos/comum.jsx`).
- **PDV** (`pages/PDV.jsx`): busca por nome/código de barras, carrinho, F2. Pedidos (`components/PedidoForm.jsx`), app do garçom (rodadas de comanda, `services/pedidos.js`), pagamento dividido e comissões usam `sale_items.preco_unitario`.
- Cadastro: `pages/produtos/FormProduto.jsx` e `EditarProduto.jsx` (nome, categoria, unidade, EAN, custo, venda, fornecedor, receita/combo, grupos, iFood). O saldo não é cadastrado ali (ícone de caixa).

## 4. Banco de dados e regras (adapte ao código real e **justifique desvios** no relatório)

Migration(s) com o próximo número livre:

- `produto_precos`: `tenant_id, product_id, location_id, preco_venda NUMERIC(12,2) NULL (NULL = herda products.preco_venda), vende BOOLEAN NOT NULL DEFAULT true`, único por `(product_id, location_id)`. Sem linha = herda o padrão e vende.
- `produto_faixas` (descontos por quantidade): `id, tenant_id, product_id, location_id UUID NULL (NULL = vale para todas as lojas que não tenham faixas próprias), rotulo TEXT, quantidade_minima INT CHECK (>= 2), preco_unitario NUMERIC(12,2) NOT NULL (valor guardado já em reais por unidade), modo_cadastro ('unitario'|'kit'|'percentual') e valor_cadastro NUMERIC (como o usuário informou, para reabrir a tela igual), automatica BOOLEAN NOT NULL, ean_pack TEXT NULL, ativo BOOLEAN DEFAULT true, criado_em`. **Se a loja tem faixas próprias, elas substituem as gerais** naquela loja.
- Validações (servidor e tela): `preco_unitario > 0`; **menor que o preço unitário da loja**; faixas da mesma loja com `quantidade_minima` **distintas** e preços **decrescentes** conforme a quantidade cresce; **kit**: o preço do kit precisa **dividir em centavos exatos** pela quantidade (R$ 48,00 ÷ 6 = 8,00 ok; R$ 50,00 ÷ 6 → recusar com mensagem pedindo outro valor); **percentual** arredonda o preço unitário para centavos. **Alerta** (não bloqueia) se o preço da faixa ≤ custo ou a margem < 10%. `ean_pack` **único na empresa** e **não pode coincidir** com nenhum `products.barcode` nem outro `ean_pack` (8–14 dígitos).
- `sale_items`: acrescentar `preco_tabela NUMERIC(12,2)` (preço unitário da loja antes da faixa) e `faixa_rotulo TEXT` para relatório de "desconto por quantidade" (nulos nas vendas antigas e nas vendas sem faixa). O preço realmente cobrado continua em `preco_unitario`.
- **Conversão em insumo** — `produto_conversoes`: `tenant_id, product_id (único), ingredient_id, fator NUMERIC(14,4) > 0 (quantidade de insumo por 1 unidade do produto, na unidade do insumo), modo ('perguntar'|'sempre') DEFAULT 'perguntar', ativo`; `produto_conversao_lojas (product_id, location_id)` = lojas em que vira insumo. Opção de **criar o insumo** a partir do produto no próprio cadastro (nome padrão = nome do produto; unidade do insumo escolhida; custo inicial = custo do produto ÷ fator). Validar compatibilidade básica de unidades (ex.: produto `L` com insumo `ML`/`L`; produto `KG` com `G`/`KG`; produto `UN` com `UN`/`Fatia`/`G`/`ML` exige fator explícito) e **bloquear** conversão do produto em **ele mesmo/ciclo** (insumo que tenha o produto na ficha).
- **Regra de preço** (serviço único, ex.: `services/precos.js`, usado por **todos** os caminhos de venda): `precoDoProduto(db, tenantId, productId, locationId, quantidade, { faixaId })` devolve `{ preco_tabela, preco_unitario, faixa|null, vende }`:
  1. Preço da loja = `produto_precos.preco_venda` da loja, senão `products.preco_venda`. `vende=false` → **a venda/pedido do produto é recusada (400)** e ele **não aparece** no PDV/pedidos/garçom daquela loja.
  2. Faixas da loja (ou as gerais, se a loja não tiver próprias). **Automáticas**: vale a de **maior** `quantidade_minima` ≤ quantidade. **Manual**: só se o cliente da API mandar `faixa_id` e a quantidade ≥ mínimo; se houver automática e manual elegíveis, vale a de **menor preço unitário** (nunca soma/empilha).
  3. Aplicada a faixa, **todas as unidades** do produto naquele documento pagam `preco_unitario` da faixa (R$ 8,00 × 8 un = R$ 64,00; não existe "6 no pack + 2 avulsas").
  4. A quantidade considerada é a **soma do mesmo produto no documento** (linhas com observações diferentes somam; use o mesmo agrupamento de `agruparItens`).
  5. **Documento** = a venda do PDV, o pedido ou a **rodada** de comanda. **Nunca some quantidades entre rodadas** (os recebimentos "na hora" do garçom já foram cobrados por rodada; o fechamento da comanda deve **repetir exatamente** os preços das rodadas, mesmo que o total junto atingisse outra faixa).
  6. Complementos continuam somando por cima do preço. Combos e produtos controlados por insumos (lanches) **aceitam preço por loja**; faixas de quantidade ficam **desabilitadas para combos**.
  7. O **desconto manual da venda** (permissão `Desconto`) continua existindo, separado e aplicado depois.
- **Plataformas e site**: iFood/99Food (`precos_informados`) **não mudam**. Loja virtual: **mantém** o preço base e as promoções atuais (decisão futura: usar o preço da loja vinculada ao site). **Grades/variações**: cada variação é um produto e pode ter seus preços; **não** é obrigatório copiar faixas entre variações (opcional: ação "copiar para as variações").

## 5. O que fazer

### 5.1 Back-end
- Migration(s) e `services/precos.js` com **testes unitários** das regras acima (incluindo arredondamento).
- **Cadastro**: `GET /products/:id` devolve também `precos_lojas` (por loja: preço próprio ou herdado, `vende`, margem) e `faixas` (por loja + gerais) e `conversao`; `PUT /products/:id` (e `POST /products`) aceitam essas estruturas e gravam em **uma transação**, com as validações de 4. Permissões conforme seção 2; auditoria (`logAudit`) de mudança de preço/faixa/conversão com antes e depois.
- **Consulta para venda** (`GET /products/search`, usado por PDV/pedidos/garçom): quando há `terminal_id`/`location_id`, devolver `preco_venda` **da loja**, `vende` (produtos que não vendem na loja **não aparecem**), as **faixas elegíveis** (rótulo, mínimo, preço unitário, kit, automática/manual) e, na busca por **código de barras de pack** (`ean_pack`), o produto já com `quantidade` = mínimo da faixa e a faixa marcada.
- **Venda e pedidos** (`services/vendas.js`, `services/pedidos.js`, rodadas do garçom, fechamento de comanda, pagamento dividido): trocar a leitura direta de `preco_venda` por `precoDoProduto`; aceitar `itens[].faixa_id` opcional (faixa manual); gravar `preco_unitario` (cobrado), `preco_tabela` e `faixa_rotulo`. O **servidor é a verdade**: o total do cliente é recalculado; se o front mandou outro valor, ignore. Mantém comissões, relatórios e financeiro coerentes (sem alterar a regra deles; só o preço do item muda).
- **Transferência com conversão**: em `POST /stock-movements` (`tipo: 'transferencia'`), se o produto tem conversão ativa e a **loja de destino** está na lista:
  - modo `perguntar`: o corpo **precisa** trazer `converter_em_insumo: true|false` (sem isso → 400 "informe se converte em insumo"); modo `sempre`: converte (e `false` é recusado ou ignorado, documente);
  - ao converter, numa transação: baixa `quantidade` do **produto** na origem, **soma** `quantidade × fator` no **insumo** do destino (`ingredient_balances`), com **custo médio ponderado** do insumo recalculado a partir de `custo do produto ÷ fator` (reaproveite a rotina de entrada de insumo), e grava **movimentos auditáveis** dos dois lados ligados entre si (aparecem no histórico do produto e do insumo como "Transferência com conversão"). Reserva de estoque/ficha técnica seguem funcionando.
  - sem conversão: transferência comum (comportamento atual).
  - Não existe "desconverter" (correção por balanço). Falta de saldo → 409 como hoje.
- **Relatórios**: no relatório de vendas/itens, mostrar **desconto por quantidade** (soma de `(preco_tabela − preco_unitario) × quantidade`) quando houver; valor do estoque a preço de venda (`reports.routes.js` ~linha 343) passa a usar o preço **da loja** do saldo.

### 5.2 Front-end — Cadastro do produto (seguir o preview, aba 1)
Em `FormProduto.jsx`/`EditarProduto.jsx` (ou componentes novos `PrecosLoja.jsx` e `ConversaoInsumo.jsx`):
- **Preço de venda padrão** (o campo de hoje) com o texto "vale para lojas sem preço próprio" e margem; **custo** com a dica "o custo é igual em todas as lojas".
- Seção **"Preços por loja e por quantidade"**: interruptor "Preço diferente por loja"; um botão por loja (indicador verde = vende / cinza = não vende); por loja: preço unitário (placeholder = padrão), margem e lucro por unidade, "Vende nesta loja?", "Copiar regras de…"; tabela de **faixas** com: nome, "a partir de N un", "informar por" (**preço por unidade / preço do kit / % de desconto** — ao trocar, converte o valor para o novo modo sem perder o resultado), valor, e **colunas calculadas** (por unidade, kit fechado, desconto %, margem), **Aplicação** (Automático / Só se escolher), EAN do pack opcional, botão remover e **alertas** (abaixo do custo, margem baixa, não menor que a unidade, quantidade repetida); botão **+ faixa** (sugere o dobro da última); **resumo por loja** em tabela. Com o interruptor desligado, edita-se um conjunto único de preço/faixas para todas as lojas.
- Seção **"Pode virar insumo na transferência"**: interruptor; escolher insumo existente **ou criar a partir do produto**; "1 `<unidade do produto>` = `<fator>` `<unidade do insumo>`"; custo do insumo calculado; **lojas** em que vira insumo (marcadas "insumo" / "continua produto"); modo "Converter sempre" × **"Perguntar ao transferir"** (padrão); nota de que a ficha técnica usa o insumo.
- Não exibir/aceitar faixas para **combos**; permissões respeitadas (sem permissão, tela só leitura). Validações iguais às do servidor, mensagens claras.

### 5.3 Front-end — Transferência (aba 2)
`EstoqueProduto.jsx` → `TelaTransferencia`: quando o destino tem conversão ativa, mostrar o **quadro de conversão** (produto na origem antes → depois; "+ N ML de insumo"; saldo do insumo antes → depois; custo médio) e, no modo `perguntar`, o interruptor **"Converter em insumo neste destino"** (padrão ligado; enviado como `converter_em_insumo`). Sem conversão, mostrar a transferência comum. Atualizar o histórico para exibir "Transferência com conversão em insumo".

### 5.4 Front-end — PDV, Pedidos e Garçom (aba 3)
- **PDV** (`PDV.jsx`): o preço da busca e do carrinho é o **da loja do terminal**; produto que não vende na loja não aparece. **Faixa automática**: ao chegar na quantidade, o preço do pack aparece sozinho com a economia ("Pack 6: cada unidade sai por R$ 8,00 em vez de R$ 9,50 · economia R$ 9,00"). **Faixa manual**: aparece o botão **"Aplicar <rótulo>"** (envia `faixa_id`). Dica **"faltam N un para o <rótulo>"** com botão de adicionar. Atalho **"ler EAN do pack"** (o leitor de código de barras do pack adiciona a quantidade da faixa). Linha mostra "Pack 6" e o preço da tabela riscado. Total e margem corretos; mantenha atalhos de teclado (F2, setas, `3*`).
- **Pedidos** (`PedidoForm.jsx`) e **app do garçom**: mesmos preços por loja e faixa **por pedido/rodada** (regra 4.5); o app do garçom mostra o preço da loja e a faixa quando atingida; o fechamento da comanda usa os preços já gravados nas rodadas.
- Telas de lista (`ListaProdutos`): coluna de preço mostra o preço da **loja selecionada no filtro** (ou o padrão, com um indicador "preços por loja" quando houver variação).

## 6. Testes obrigatórios (rodar e mostrar o resultado)

Crie `backend/scripts/e2e-precos.mjs` (padrão dos e2e existentes) e teste no navegador (inclusive 375 px):

1. **Preço por loja**: o mesmo produto vende por preços diferentes em duas lojas; loja sem preço próprio usa o padrão; **"não vende"** → produto some da busca e a venda direta pela API é recusada (400); margem por loja correta com custo único.
2. **Faixa automática**: 1 un = preço da loja; 6 un = 6 × R$ 8,00; **8 un = 8 × R$ 8,00** (não "6 + 2"); 24 un = faixa maior; `sale_items` guarda `preco_unitario`, `preco_tabela`, `faixa_rotulo`; total, troco e caixa corretos; comissões e financeiro **sem regressão**.
3. **Faixa manual**: sem `faixa_id` não aplica; com `faixa_id` e quantidade ≥ mínimo aplica; com quantidade menor → 400; automática + manual elegíveis → vale a de **menor preço**, sem empilhar.
4. **Lojas diferentes, regras diferentes**: Distribuidora aplica o pack automático; Casa de show tem regra própria (manual); loja sem faixas própria herda as **gerais** só se não tiver nenhuma própria.
5. **Mesmo produto**: dois itens do mesmo produto com observações diferentes **somam** para a faixa; produtos **diferentes** não somam.
6. **Rodadas/comanda**: duas rodadas de 3 un não atingem a faixa de 6 (cada rodada isolada); o fechamento da comanda **repete** os preços das rodadas; um recebimento "na hora" de uma rodada + o fechamento no caixa fecham o total exato.
7. **EAN do pack**: leitura do código do pack devolve o produto com a quantidade da faixa; EAN duplicado ou igual a um código de barras de produto → 409.
8. **Validações**: preço da faixa ≥ preço unitário → 400; quantidades repetidas → 400; kit que não divide em centavos → 400; preço abaixo do custo → alerta (permite); faixa em combo → recusada.
9. **Conversão**: produto L → insumo ML (fator 1000): transferir **3 L** para loja marcada → origem −3 L, destino **+3.000 ML**, custo médio ponderado do insumo correto, movimentos ligados no histórico; modo `perguntar` sem `converter_em_insumo` → 400; `false` mantém produto; destino **não** marcado → transferência comum; saldo insuficiente → 409; ciclo/mesmo item → recusado.
10. **Permissões e isolamento**: só quem pode editar produtos altera preços/faixas/conversão; operador de caixa não; outra empresa/loja não enxerga; auditoria registra antes/depois.
11. **Plataformas/site**: pedidos do iFood/99Food mantêm o preço da plataforma; loja virtual mantém preço base/promoção.
12. **Regressão**: todas as suítes e2e existentes (estoque-vendas, módulos, combos, garçom 1–3, financeiro, relatórios, iFood, 99Food, loja virtual, dados-empresa, master, 2FA, redefinir-senha, modo-teste) — compare com a execução anterior; temas claro e escuro nas telas novas.

## 7. Fora do escopo

Tabela de preço por **cliente**/atacado cadastrado; desconto por mistura de produtos; preço por **horário/dia** (happy hour); custo por loja; preço da **loja virtual** por loja; copiar faixas entre variações de grade (opcional); "desconverter" insumo; conversão automática em outros movimentos além da transferência (entrada de nota, balanço).

## 8. Ordem sugerida de commits

1. Migrations + `services/precos.js` com testes unitários. 2. Cadastro: gravar/ler preços por loja, faixas e conversão (API + validações + auditoria). 3. Busca de produtos (`/products/search`) por loja, faixas e EAN do pack. 4. Venda/pedidos/rodadas usando `precoDoProduto` (+ colunas em `sale_items`). 5. Transferência com conversão em insumo. 6. Front: seção de preços e faixas no cadastro. 7. Front: conversão no cadastro e na transferência. 8. Front: PDV, pedidos e garçom. 9. Relatórios e lista de produtos. 10. e2e novo e regressão.

## 9. Entrega

Rode os testes da seção 6 e faça um **relatório em português**: o que foi feito por commit, decisões e **desvios do desenho** (com o motivo), **lista de todos os pontos que passaram a usar `precoDoProduto`**, exemplos numéricos conferidos (pack, 8 un, rodadas), resultados (inclusive falhas), pendências e qualquer funcionalidade existente que você **não removeu** mas notou conflito.

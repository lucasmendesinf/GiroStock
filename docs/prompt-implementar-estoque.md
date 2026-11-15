# Prompt — Implementar a tela "Produtos & Estoque" separada (front-end + back-end)

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> O modelo visual **já foi validado** pelo cliente: `docs/estoque-preview/preview-estoque.html`.

---

## 1. Objetivo

Separar **cadastro de produto** de **tratamento de estoque** na tela *Produtos*:

- a lista de produtos mostra, no fim de cada linha, **um ícone de lápis (editar)** e **um ícone de caixa (estoque)**;
- o ícone de caixa abre um **modal só de estoque** (saldo por loja, entrada, transferência, saída, balanço, histórico);
- produto **controlado por insumos** (lanche/receita) não tem estoque próprio: a edição dele abre a **configuração dos insumos**, no lugar de "Tratar estoque";
- campos de dinheiro passam a usar **máscara de real brasileiro** e as contas de venda/caixa passam a ser feitas em **centavos inteiros**.

**A tela final deve ficar visual e funcionalmente igual ao preview.**

## 2. Fonte da verdade visual (leia primeiro)

Arquivo: `docs/estoque-preview/preview-estoque.html` (HTML único, com CSS e JS embutidos).

1. Sirva e abra em uma **aba normal do navegador** (alguns visualizadores bloqueiam scripts):
   ```bash
   cd docs/estoque-preview
   npx --yes serve -l 8099 .      # ou: python -m http.server 8099
   ```
   Abra `http://localhost:8099/preview-estoque.html`.
2. Clique em **tudo**: ícone de caixa, lápis, nome do produto, "+ Novo produto", "Entrada por nota", chips de filtro, as 6 abas do modal, botão de tema claro/escuro.
3. Leia o código do arquivo: ele é a especificação exata de **textos, ordem dos campos, cores, estados, mensagens de erro e cálculos de pré-visualização** (ex.: "Saldo em Loja: 42 → 52 UN", "Custo médio: R$ 1,25 → R$ 3,89 (média ponderada)").
4. Os **dados do preview são fictícios**. No sistema use a API real. O que for visual (estrutura HTML, classes de cor, textos) copie fielmente, adaptando para React e para as variáveis CSS que o projeto já tem (`--bg`, `--panel`, `--gold-light`, `--ok`, `--err` etc. — tema claro e escuro precisam continuar funcionando).

## 3. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se achar algo que **remove funcionalidade existente**, **não remova**: mantenha e liste no relatório final.
- Em arquivos com quebra de linha CRLF (Windows), preserve CRLF ao editar.
- Valide no navegador (`npm run dev` no `frontend` e no `backend`) antes de dizer que terminou; type-check/build não bastam.
- Antes de rodar, depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.

## 4. Estado atual do sistema (para você se localizar)

Front (`frontend/src`):
- `pages/Products.jsx` — container com abas: Produtos · Estoque & Movimentações · Entrada por nota · Insumos.
- `pages/produtos/ListaProdutos.jsx` — tabela (Produto, Categoria, Fornecedor, Venda, Custo, Margem, Estoque), filtros, botão Categorias.
- `pages/produtos/FormProduto.jsx` — cadastro (hoje pede **estoque inicial + local**).
- `pages/produtos/DetalheProduto.jsx` — modal grande que mistura: editar produto, **estoque por loja** (mínimo por loja), **entrada de compra**, **ficha técnica**, últimas movimentações.
- `pages/produtos/Movimentacoes.jsx` — aba com formulário de entrada/saída/transferência, alertas de estoque baixo e histórico filtrável.
- `pages/produtos/EntradaNota.jsx`, `Insumos.jsx`, `Categorias.jsx`, `comum.jsx`.
- `components/ui.jsx` (`Field`, `Modal`, `Paginacao`, `Vazio`), `utils/format.js` (`brl`, `qtd`, `parseNumero`...), `context/UiContext.jsx` (toasts/confirmar).

Back (`backend/src/routes`):
- `products.routes.js`: `GET /products`, `GET /products/:id`, `POST/PUT /products`, `PUT /products/:id/minimum`, `POST/DELETE /products/:id/ingredients...`, `GET /stock/alerts`.
- `stock.routes.js`: `POST /stock-movements` (entrada/saida/transferencia), `POST /stock-entries` (nota com vários itens), `GET /stock-movements`.
- `ingredients.routes.js`: entradas, saídas, transferências, balanço e mínimo de insumos.
- Enum `stock_move_type` = `('entrada','saida','transferencia')` (migration 001).
- Regras já existentes que **devem ser preservadas**: ver seção 8.

## 5. O que construir (preview → sistema)

### 5.1 Lista de produtos (`ListaProdutos.jsx`)
Igual ao preview:
- Colunas: foto (placeholder), **Descrição** (nome clicável → abre edição; subtítulo `Categoria · EAN`), Código, Un., Preço, **Estoque**, ações.
- **Ações por linha: só dois ícones** — lápis (editar) e caixa (estoque). Sem menu "⋮", sem outros ícones.
- A caixa tem tooltip: **"Tratar estoque"**; em produto composto: **"Controlar insumos"**.
- **Cor da linha pela situação** (faixa lateral de 4 px + fundo suave + número colorido + pílula):
  - **verde** = estoque ok; **amarelo** = baixo; **vermelho** = sem estoque.
  - Produto comum: vermelho se total = 0; amarelo se alguma loja está `abaixo_minimo` (use o campo que a API já devolve, regra do sistema `saldo <= estoque_minimo` com mínimo > 0); senão verde.
  - Produto composto: coluna mostra pílula "por insumos" + situação: `0` → vermelho "falta insumo"; `≤ 5` → amarelo "dá para N"; senão verde "dá para N", onde N = menor valor de `floor(disponível do insumo / qtd por unidade)` entre os insumos da receita.
  - O ícone da caixa também assume a cor da situação.
- **Legenda** acima da tabela (Estoque ok / Estoque baixo (abaixo do mínimo da loja) / Sem estoque).
- **Chips de filtro**: Todos · Estoque baixo · Sem estoque · Controlados por insumos. Filtro de **loja** troca a coluna para "Estoque (Loja X)"; sem loja = "todas as lojas".
- Mantenha busca (código, descrição, EAN), filtros já existentes de categoria/fornecedor/situação e o botão "Entrada por nota" (**continua uma aba separada**, decisão do cliente) e "+ Novo produto".

### 5.2 Modal de estoque — novo componente `EstoqueProduto.jsx`
Abre pelo ícone de caixa de produto **comum**. Modal grande, fecha com Esc e clique no fundo. Cabeçalho: "Tratar estoque", nome, `código · EAN · unidade`.
- **KPIs**: Estoque total · Custo médio · Valor em estoque (total × custo) · Situação (pílula).
- **Abas** (exatamente estas, nesta ordem): **Saldo por loja · Entrada · Transferência · Saída · Balanço · Histórico**.
- **Saldo por loja**: tabela Loja / Saldo / **Mínimo (editável, salva ao sair do campo via `PUT /products/:id/minimum`)** / Situação / botões "+ Entrada" e "Transferir" (este desabilitado sem saldo) que já trocam de aba com a loja pré-selecionada.
- **Entrada**: loja, quantidade, custo unitário da compra, fornecedor, nota fiscal, observação. Mostra, antes de confirmar: `Saldo em <loja>: X → Y` e, havendo custo, `Custo médio: A → B (média ponderada)`. Bloqueios com a mensagem do preview: UN/CX só inteiro; custo médio ≥ preço de venda → "Entrada recusada…".
- **Transferência**: origem, destino, quantidade, motivo. Mostra saldo antes→depois das duas lojas. Bloqueia origem = destino e quantidade > saldo. Botão só habilita com motivo ≥ 3 caracteres.
- **Saída**: loja, quantidade, motivo (lista: Perda / quebra, Validade vencida, Uso interno / consumo, Brinde / bonificação, Outro) + observação. Mostra saldo antes→depois e o **custo da perda** (qtd × custo). Aviso: vendas pelo PDV já baixam o estoque sozinhas.
- **Balanço**: loja, contagem física (novo saldo), motivo (≥ 3). Mostra diferença (`+N`/`-N`). Botão extra **"Zerar estoque desta loja"** (preenche 0 e foca o motivo). **Substitui o saldo** e guarda a diferença no histórico.
- **Histórico**: movimentações do produto (tipo colorido: entrada verde, saída vermelha, transferência dourada, balanço âmbar; De/Para; motivo; data/hora).
- Reaproveite os endpoints e a lógica que já existem em `DetalheProduto.jsx`/`Movimentacoes.jsx`. **Remova de `DetalheProduto.jsx`** as seções de estoque (estoque por loja, entrada de compra, movimentações) — agora vivem no modal de estoque — ou transforme o que sobrar em edição de produto.

### 5.3 Balanço de produto (backend novo)
Hoje só **insumos** têm balanço. Criar `POST /api/products/:id/stock-adjustment` `{ location_id, novo_saldo, motivo }`:
- exige área Estoque + acesso à loja (`assertLocationAccess`), valida UN/CX inteiro, `novo_saldo >= 0`, motivo ≥ 3;
- trava a linha de `stock_balances` (`FOR UPDATE`), grava o saldo novo, registra **auditoria** e um registro em `stock_movements`;
- adicionar `'balanco'` ao enum `stock_move_type` (nova migration `007_...sql`, `ALTER TYPE stock_move_type ADD VALUE IF NOT EXISTS 'balanco'`) e ajustar leituras/relatórios/filtros que listam o tipo; o histórico deve mostrar "de X para Y" (guardar no motivo ou em campo próprio, como preferir, mantendo o texto igual ao do preview).
- Produto composto (com ficha técnica) é recusado (400), como as demais operações de estoque de produto.

### 5.4 Cadastro/edição do produto (`FormProduto.jsx` / `DetalheProduto.jsx`)
Igual ao preview:
- Edição e cadastro tratam **só dados do produto**: nome, categoria, unidade, EAN, fornecedor(es), preço de custo, preço de venda. **Sem "estoque inicial" e sem "local"**. Texto de aviso do preview: *"O saldo não é cadastrado aqui: depois de salvar, use o ícone de caixa…"*. Ajuste `POST /products` para **aceitar produto comum sem `location_id`/`estoque_inicial`** (mantendo compatibilidade se vierem). Após salvar um produto novo, mostre o toast do preview.
- Em produto **comum**, na edição, botão **"Tratar estoque →"** (abre o modal de estoque). Em produto **composto** esse botão **não existe**.
- Em **+ Novo produto**: checkbox **"Produto controlado por insumos (lanche / receita)"**; marcado, aparece o editor da receita e o campo de custo fica **somente leitura**.
- **Editor de insumos (receita)** — seção "Controle por insumos (receita)":
  - aviso: produto não tem estoque próprio; cada venda baixa os insumos e é bloqueada se faltar; "Hoje dá para vender N unidade(s)" (ou "— falta insumo.");
  - tabela: Insumo · **Qtd por unidade (editável)** · Disponível · Dá para (pílula vermelha 0 / amarela ≤5 / verde) · Custo fracionado (qtd × custo unitário do insumo) · botão remover (×);
  - linha final: **"Custo dos insumos (vira o custo do produto)"** = soma; o campo **Preço de custo** recebe e trava nesse valor, recalculando a cada mudança;
  - "Adicionar insumo": select do catálogo (somente os ainda não usados, mostrando disponível) + qtd por unidade + botão;
  - rodapé: "Para repor os insumos use o menu Insumos…".
  - Validação ao salvar: ao menos 1 insumo; **preço de venda > custo dos insumos** ("O preço de venda precisa ser maior que o custo dos insumos (R$ x,xx).").
- O ícone de caixa e o lápis de produto composto abrem **essa mesma tela de edição** já rolada até a receita.
- Use os endpoints existentes de ficha técnica (`POST/DELETE /products/:id/ingredients`, `ficha_tecnica` no `POST /products`) e o custo unitário dos insumos já retornado pela API. Se faltar `custo_unitario`/`estoque` do insumo no payload, acrescente.

### 5.5 Dinheiro em reais (front + back)
- **Front**: criar `components/MoneyInput.jsx` — máscara de real (digitar `123456` → `1.234,56`), `inputMode="numeric"`, seleciona tudo ao focar, emite texto `"1.234,56"` (compatível com `parseNumero`), prop `casas` (2 padrão; **4** para custo por unidade de insumo). Aplicar em: preço de custo/venda, custo unitário (entrada de estoque, nota, movimentações), custo total e novo custo de insumos, desconto em R$ (só quando o tipo é R$), valor recebido, abertura de caixa, sangria/suprimento, fechamento. Quantidades **não** usam máscara de real.
- **Back**: criar `utils/dinheiro.js` (`centavos`, `reais`, `somar`, `arredondarCentavos`, `temNoMaximoCentavos`) e usar em vendas e caixa: subtotal, desconto, total, troco, saldo do caixa e diferença do fechamento calculados em **centavos inteiros**; rejeitar (400) mais de 2 casas decimais em desconto, valor recebido, abertura, sangria e fechamento. O banco já usa `NUMERIC`.
- **Atalho**: essa mudança já foi feita uma vez e revertida; está no histórico. Veja `git show 45bbfe9` (aplicação) e `f6e25aa` (reversão) e reaplique com `git revert f6e25aa` se o resto do código ainda for compatível; caso contrário, refaça manualmente com o mesmo desenho.

## 6. Textos e mensagens
Use **exatamente** os textos do preview (rótulos, placeholders, erros, toasts, legenda, dicas). Se precisar de texto novo, mantenha o mesmo tom (português do Brasil, direto).

## 7. Responsivo e acessibilidade
- Funciona em celular/tablet como o resto do sistema (colunas secundárias escondidas com `col-opcional`, modal com rolagem).
- Ícones são `<button>` com `aria-label`; modal fecha com Esc; foco no primeiro campo ao abrir formulários.

## 8. Regras de negócio que NÃO podem quebrar
- Todo id recebido é conferido contra a empresa (`tenant_id`) do usuário; usuário preso a uma loja só opera naquela loja.
- Produtos em `UN`/`CX` só aceitam quantidade inteira; saída/transferência nunca deixam saldo negativo; origem ≠ destino; motivo mínimo de 3 caracteres.
- Entrada com custo recalcula o **custo médio ponderado** e é recusada se o custo médio ficar ≥ preço de venda.
- Toda alteração de estoque gera `stock_movements` + auditoria (`audit_logs`) e usa transação/travas (`FOR UPDATE`, mesma ordem de travas em transferência).
- Produto composto: sem estoque próprio; venda baixa insumos e é bloqueada se faltar.
- Permissões por área (`Estoque`, `Vendas`…) e por loja continuam valendo; novas rotas usam `requireArea('Estoque')`.

## 9. Critérios de aceite (teste no navegador, tema claro e escuro)
- [ ] Lista: 2 ícones por linha; cores verde/amarelo/vermelho corretas (comum e composto); legenda e chips filtram; filtro de loja muda a coluna.
- [ ] Modal de estoque: 6 abas funcionando com a API real; saldo/custo médio mudam; mínimo editável salva; UN/CX recusam fracionado; transferência recusa mesma loja e saldo insuficiente; saída calcula custo da perda; balanço e "Zerar" funcionam e aparecem no histórico.
- [ ] Produto composto: sem "Tratar estoque"; receita editável; custo = soma dos insumos e travado; venda ≤ custo é recusada; "dá para N" confere com o PDV.
- [ ] Cadastro sem estoque inicial; produto novo aparece vermelho ("sem estoque") até a primeira entrada.
- [ ] Máscara de real em todos os campos listados; `123456` → `1.234,56`; desconto/recebido/caixa rejeitam 3 casas na API.
- [ ] Nenhuma funcionalidade anterior sumiu (Entrada por nota, Insumos, Categorias, alertas, histórico geral).
- [ ] `cd frontend && npm run build` sem erros; backend sobe e responde em `/health`.
- Opcional (só em banco local de teste — **cria uma empresa de teste**): `cd backend && API_URL=http://localhost:3000 npm run test:e2e`.

## 10. Entrega
Ao final, responda com: o que foi feito por etapa (commits), o que **não** foi feito ou foi mantido de propósito (ex.: aba "Estoque & Movimentações"), qualquer diferença em relação ao preview (com o motivo) e como testar.

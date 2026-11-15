# Prompt — Combo: código de barras automático, custos por produto e preço sugerido (margem configurável)

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Modelo visual **validado pelo cliente**: `docs/combo-preview/preview-combo.html` (modos "Novo cadastro" e "Editando"). Sirva e clique em tudo:
> ```bash
> cd docs/combo-preview && npx --yes serve -l 8089 .      # ou: python -m http.server 8089
> ```

---

## 1. Objetivo

Na criação e na edição de um **combo** (produto feito de outros produtos, `combo_itens`):

1. **Código de barras do combo gerado automaticamente, só na criação**: um código aleatório e único, porque o combo é montado com vários produtos, cada um com o seu código, e o combo precisa do dele à parte.
2. **Mostrar o custo e o valor de cada produto separadamente** ao adicioná-lo ao combo (custo unitário, custo × quantidade, preço avulso e margem dele), com totais.
3. **Preço de venda sugerido** a partir do custo total e de uma **margem desejada (padrão 30%)**, **editável**, mostrando **ao vivo** a margem %, o markup, o lucro e o desconto em relação ao preço avulso quando o valor é alterado.
4. A **margem padrão e o "terminar em ,90"** são **configurados pela própria empresa** (tela de dados da empresa); no cadastro do combo o valor só vem preenchido e pode ser mudado na hora.

Decisões já tomadas (não rediscutir):
- A margem é **sobre o preço de venda**: `preço = custo ÷ (1 − margem)`. (A "Margem" da tela de produto de hoje já é assim: `(venda − custo) ÷ venda`.)
- O preço sugerido **termina em ,90 por padrão** (a empresa pode desligar).
- **Margem padrão configurável por empresa** (padrão 30%).
- O código automático vale **só para combos e só na criação**; produto comum continua exigindo o código de barras digitado/lido, como hoje.

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador (incluindo 375 px nas telas tocadas) e por requisições reais; build não basta.
- Antes de criar migrations: `ls backend/src/db/migrations` e use o **próximo número livre** (a última conhecida é `048_imagem_produto.sql`; outras sessões podem ter criado mais).
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Dinheiro em centavos**: arredonde de forma explícita e testada (nada de ponto flutuante solto).
- **Não quebre** cadastro/edição de produtos, combos já existentes (venda, estoque, iFood, loja virtual), preço por loja e faixas de quantidade, grades, relatórios. Rode as suítes `backend/scripts/e2e-*.mjs` relacionadas (estoque-vendas, combos, precos, loja virtual, ifood) em banco recém-criado e **compare com o que passava antes**.
- Permissões: criar combo segue `Estoque`; editar segue a permissão de edição de produtos já existente (`EditarProdutos` se existir). **Configurar a margem da empresa** exige `Configuracoes`.
- Estilo: paleta atual, temas claro e escuro. Toda consulta filtra por `tenant_id`.

## 3. Estado atual (leia antes; confirme no código)

- **Cadastro de produto** (`frontend/src/pages/produtos/FormProduto.jsx`, `EditarProduto.jsx`): campo de código de barras **obrigatório** (8–14 dígitos, digitado ou lido); caixa "Combo (feito de outros produtos)" que mostra o `ComboEditor` (`ExtrasProduto.jsx`) e o custo do combo = soma `custo × quantidade` (`custoDoCombo`); preço de venda digitado, com a margem `(venda − custo) ÷ venda` e a validação "preço de venda maior que o custo".
- **`ComboEditor`** hoje lista: Produto, Qtd., **Custo (já multiplicado pela quantidade)**, Remover; não mostra custo unitário, preço avulso nem sugestão de preço. Escolha de produto por `ProdutoPicker`.
- **API** (`backend/src/routes/products.routes.js`): `POST /products` aceita `combo: [{ product_id, quantidade }]`; `assertBarcodeLivre(db, tenantId, barcode, ignorarId)`; índice único `uq_products_tenant_barcode (tenant_id, barcode)`. Há **códigos de barras de pack** em `produto_faixas.ean_pack` (migration `047_precos_faixas_conversao.sql`), também **únicos por empresa e sem colidir com o código de barras de produto** — o código gerado precisa respeitar as duas tabelas.
- **Dados da empresa** (`frontend/src/components/DadosEmpresa.jsx`, aberto pelo cabeçalho do sistema; `backend/src/routes/empresa.routes.js`: `GET /empresa`, `PUT /empresa` com `requireArea('Configuracoes')`). É o lugar das configurações por empresa.
- Custo do produto composto por insumos (lanche) já vem somado em `preco_custo`; combos não têm estoque próprio.

## 4. Banco de dados (migration com o próximo número livre)

- `tenants.combo_margem_pct NUMERIC(5,2) NOT NULL DEFAULT 30 CHECK (combo_margem_pct >= 0 AND combo_margem_pct < 95)`.
- `tenants.combo_preco_final_90 BOOLEAN NOT NULL DEFAULT true`.
- Nada muda em `products` (o código gerado é gravado em `products.barcode`).

## 5. O que fazer

### 5.1 Código de barras do combo (back-end)
- Função única `gerarCodigoBarrasInterno(db, tenantId)`: **EAN-13** com prefixo **2** (faixa reservada a uso interno da loja), 11 dígitos aleatórios com **gerador criptograficamente seguro** (`crypto.randomInt`) e **dígito verificador correto** (pesos 1 e 3). Tenta até ~20 vezes até achar um código **livre em `products.barcode` e em `produto_faixas.ean_pack`** da empresa; esgotou → erro 500 claro.
- `GET /products/codigo-barras-livre` (ou `POST`, decida e documente; `requireArea('Estoque')`): devolve `{ codigo }` livre **para a tela mostrar antes de salvar**. É uma **sugestão**: a unicidade é conferida de novo ao salvar.
- `POST /products` com `combo` não vazio: se `barcode` vier **vazio**, o servidor **gera** um código (mesma função); se vier preenchido, valida como hoje (8–14 dígitos, livre em produtos **e** em packs). Colisão na gravação (`23505` por corrida) → **gera outro e tenta de novo** (limite de tentativas) quando o código era automático; se o usuário digitou o código, responde 409 com a mensagem de hoje.
- **Produto comum** (sem `combo`): comportamento atual — **código obrigatório**, nada é gerado.
- **Edição**: `PUT/PATCH /products/:id` **nunca gera nem altera** o código sozinho; quem tem permissão de editar pode trocar **manualmente** (validação de unicidade como hoje, incluindo packs). Cobre também combos antigos sem nada a fazer.

### 5.2 Configuração da empresa
- `GET /empresa` passa a devolver `combo_margem_pct` e `combo_preco_final_90`; `PUT /empresa` aceita e valida (`0 ≤ margem < 95`, 2 casas; booleano), com auditoria (`logAudit`, antes e depois). Só `Configuracoes`.
- `DadosEmpresa.jsx`: nova seção **"Combos"** — "Margem padrão dos combos (%)" e "Terminar o preço sugerido em ,90" (interruptor), com texto "vale para os combos novos; você pode mudar a margem em cada combo ao cadastrá-lo". Somente leitura para quem não tem `Configuracoes`.
- `GET /auth/me` (ou o que a tela de produtos já consulte para dados da empresa) deve expor esses dois valores para o formulário de produto **sem exigir** `Configuracoes` (qualquer usuário que cadastra produtos precisa lê-los).

### 5.3 Cálculo do preço sugerido (regra única, testada)
Função pura compartilhada pelo front (e conferida no servidor ao salvar não é necessária, o preço final é o que o usuário confirmar):
- `custo_total = Σ custo_unitario × quantidade` (em centavos).
- `sugerido_bruto = custo_total ÷ (1 − margem/100)`; se `custo_total ≤ 0` ou `margem ≥ 95` → sem sugestão.
- Com **",90" ligado**: o **menor valor terminado em ,90 que seja ≥ `sugerido_bruto`** (ex.: 66,14 → 66,90; 66,95 → 67,90; 10,00 → 10,90). Desligado: arredonda para **centavos** (meio para cima).
- Margem real = `(preço − custo_total) ÷ preço`; markup = `(preço − custo_total) ÷ custo_total`; lucro = `preço − custo_total`; desconto sobre o avulso = `(soma dos preços avulsos − preço) ÷ soma dos preços avulsos`.
- Tolerância de 0,05 ponto percentual ao comparar a margem real com a desejada (o arredondamento em centavos não deve gerar o aviso "abaixo da margem").

### 5.4 Front-end — cadastro e edição do combo (seguir o preview)
Em `FormProduto.jsx`/`EditarProduto.jsx` e `ExtrasProduto.jsx` (`ComboEditor`):
- **Código de barras do combo**: ao marcar "Combo", o campo é **preenchido sozinho** com o código sugerido pelo servidor (5.1), com botão **"↻ Gerar outro"** e a opção de digitar o seu; mensagem de validação ao vivo ("✔ Código válido · gerado automaticamente" ou erro de formato). **Desmarcar "Combo"** limpa o código gerado (produto comum volta a exigir o código). Na **edição** o campo aparece **travado ("🔒 fixo")** com explicação e botão **"Trocar manualmente"** (só com permissão de editar).
- **Tabela "Produtos do combo"**: colunas **Produto (com a etiqueta "lanche (insumos)" quando for o caso), Código (PRD e código de barras), Qtd., Custo unit., Custo (qtd × unit.), Preço avulso unit., Preço avulso (qtd ×), Margem avulso, Remover**; rodapé com **total do custo** e **soma dos preços avulsos** (e a margem avulsa total). Ao escolher um produto na busca (nome, código ou código de barras), ele entra mostrando o custo (aviso curto). Mudar a quantidade atualiza totais sem recarregar a tela. Combo dentro de combo continua proibido; usa o preço de venda **padrão** do produto (informe isso numa dica, pois pode haver preço por loja).
- **Bloco "Preço do combo"**: campos **Margem desejada (%)** (vem da empresa; mudar vale só para este combo), **Preço sugerido** (calculado, em destaque), **Preço de venda do combo** (editável), botão **"Usar o sugerido"** e interruptor **"Terminar em ,90"** (vem da empresa, mudável aqui). Enquanto o preço for o sugerido ele **acompanha** mudanças de produtos/quantidades/margem; ao digitar outro valor passa a **manual** (indicação visual) até clicar em "Usar o sugerido".
- **Indicadores ao vivo** (quadros): custo do combo, lucro por combo, **margem sobre a venda** (verde ≥ desejada, laranja abaixo, vermelha < 15% ou preço ≤ custo) com o **markup ao lado**, e **desconto sobre o avulso**; barra de margem e texto de apoio ("faltam R$ X para chegar na margem desejada" / "abaixo ou igual ao custo: dá prejuízo").
- **Validação ao salvar**: preço de venda **maior que o custo** (já existe) continua bloqueando; margem abaixo da desejada é **só aviso**.
- Layout responsivo (375 px) sem rolagem horizontal da página (a tabela rola dentro do próprio quadro); temas claro e escuro.

## 6. Testes obrigatórios (rodar e mostrar o resultado)

Crie `backend/scripts/e2e-combo-codigo-preco.mjs` (padrão dos e2e existentes) e teste no navegador:

1. **Gerador**: 1.000 códigos → todos com 13 dígitos, prefixo 2, **dígito verificador válido**, **sem repetição**; nenhum coincide com `products.barcode` nem `produto_faixas.ean_pack` existentes.
2. `GET /products/codigo-barras-livre` devolve código livre; depois de **ocupar** esse código (produto ou pack), o servidor **não o usa** ao gerar de novo.
3. **Criar combo sem código** → o servidor gera e grava; criar **dois combos ao mesmo tempo** (corrida) → códigos **diferentes**, sem erro; criar combo **com código digitado** → aceita; código já usado por produto **ou** por pack → **409**.
4. **Produto comum sem código de barras → 400** (como hoje); produto comum **nunca** recebe código automático.
5. **Editar** combo **não muda** o código; trocar manualmente funciona com permissão e respeita a unicidade (inclusive packs); sem permissão → 403.
6. **Preço sugerido** (teste unitário da função): casos 66,14 / 66,95 / 66,90 / 10,00 com ",90" ligado; desligado em centavos; margens 0, 30, 94,99; `custo_total = 0`; quantidades fracionadas; arredondamento sem erro de ponto flutuante.
7. **Tela** (navegador): o custo unitário, o total e o preço avulso de **cada produto** aparecem corretos e batem com o cadastro; ao mudar quantidade/produto o sugerido **acompanha**; digitar preço manual **para de acompanhar**; margem, markup, lucro e desconto mudam na hora; preço ≤ custo bloqueia o salvamento; margem abaixo da desejada só avisa.
8. **Configuração da empresa**: alterar a margem (ex.: 40%) e o ",90" em Dados da empresa muda o valor **pré-preenchido** nos combos novos (e não altera combos existentes); `PUT /empresa` valida faixas (margem 95 → 400) e exige `Configuracoes`; usuário sem essa permissão **lê** os valores no cadastro mas não edita; auditoria registrada.
9. **Regressão**: combos já existentes (editar, vender, baixa de estoque, iFood, loja virtual), preço por loja/faixas de quantidade, grades, `e2e-estoque-vendas`, `e2e-combos`, `e2e-precos`, `e2e-loja-virtual` (com simuladores), `e2e-ifood` — compare com a execução anterior; temas claro e escuro.

## 7. Fora do escopo

Reprecificação automática dos combos quando o custo de um componente mudar (apenas pode ser sugerida como melhoria futura: aviso "o custo do combo mudou"); preço **por loja** do combo (vale a regra de preço por loja que já existe para qualquer produto); modo **markup** como padrão (o cálculo é sempre sobre a venda); alterar combos existentes em lote; gerar códigos para produtos comuns.

## 8. Ordem sugerida de commits

1. Migration (margem e ",90" da empresa) + `GET/PUT /empresa` e seção "Combos" em Dados da empresa. 2. Gerador de código de barras interno, endpoint de código livre e geração automática no `POST /products` de combo (com retry e checagem de packs). 3. Função de preço sugerido (teste unitário) e exposição dos valores da empresa ao formulário. 4. Front: tabela "Produtos do combo" com custos e preços por produto. 5. Front: código automático/travado e bloco "Preço do combo" com indicadores ao vivo. 6. e2e novo e regressão.

## 9. Entrega

Rode os testes da seção 6 e faça um **relatório em português**: o que foi feito por commit, decisões e **desvios do desenho** (com o motivo), exemplos numéricos conferidos (custo, sugerido com e sem ",90", margem real), resultados (inclusive falhas e o que já falhava antes), pendências e qualquer funcionalidade existente que você **não removeu** mas notou conflito.

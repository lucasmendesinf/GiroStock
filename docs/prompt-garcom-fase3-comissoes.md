# Prompt — Garçom, Fase 3/3: Comissões (regras, cálculo, extrato, acerto e Financeiro)

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Modelo visual **validado**: `docs/garcom-preview/preview-garcom.html` (abas **Comissões (gestão)** e **Regras e perfil**, e o **extrato** no app do garçom).
> ```bash
> cd docs/garcom-preview && npx --yes serve -l 8092 .      # ou: python -m http.server 8092
> ```
> **Pré-requisitos: Fases 1 e 2 concluídas** (`prompt-garcom-fase1-app-comandas.md` e `prompt-garcom-fase2-receber-na-hora.md`): comandas, `order_items.garcom_id`, `comanda_pagamentos`, `sale_payments`, `sales.taxa_servico`. Confira `git log` e `ls backend/src/routes`; se faltar, **pare e avise**. Faça **somente a Fase 3**.

---

## 1. Objetivo

**Comissão por garçom**, calculada das vendas das comandas e paga em **acertos** periódicos:
1. **Regras** configuráveis: percentual padrão, **por categoria**, **taxa de serviço repassada**, base **líquida ou bruta**, **bônus por meta**.
2. **Cálculo automático** no momento em que o **dinheiro entra** (recebimento na hora ou fechamento da comanda no caixa), **por item** (garçom que lançou), com estornos tratados.
3. **Extrato do garçom** no app (a comissão da noite, por comanda).
4. **Tela de gestão "Comissões"**: resumo por garçom, extrato por comanda, **fechar acerto**, recibo e **lançamento no Financeiro**.

Decisões já tomadas / **padrões recomendados** (tudo configurável; não trave no código):
- A comissão **nasce quando o dinheiro entra**: quando um recebimento é confirmado (Fase 2) ou quando o caixa fecha a comanda. **Não** há comissão de rodada apenas enviada, de comanda aberta, cancelada ou estornada.
- O garçom que **lançou o item** (`order_items.garcom_id`) recebe a comissão **daquele item** (transferir comanda não muda isso). Divisão manual entre garçons é um **ajuste** (ver 5.4).
- **Taxa de serviço**: parte configurável (padrão **100%**) repassada ao garçom, **proporcional aos itens dele**.
- Base **líquida** (depois de desconto) por padrão.
- Comissão por **categoria de produto** com padrão geral; produtos marcados "fora da comissão" (ex.: ingresso, couvert) **não geram**.

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador e por requisições reais; build não basta.
- Migrations: `ls backend/src/db/migrations` e use o **próximo número livre**.
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Dinheiro dos funcionários**: arredonde sempre em **centavos** (use inteiros em centavos ou `NUMERIC` com arredondamento definido; documente). Testes numéricos rigorosos; nada de erro de ponto flutuante.
- **Não quebre** vendas, caixa, relatórios, financeiro, Pedidos, Fases 1 e 2, Master, modo teste, suporte.
- Estilo: paleta atual, temas claro e escuro. Toda consulta filtra por `tenant_id` e respeita lojas.

## 3. Estado atual (leia antes; confirme no código)

- `order_items.garcom_id` (quem lançou), `comandas` (`sale_id`), `comanda_pagamentos` (recebimentos por rodada, `status confirmado|estornado`), `sale_payments`, `sales.taxa_servico`, `sale_items`/`order_items` com categoria via `products`.
- **Financeiro** (`routes/financeiro.routes.js`, tabelas `fin_categorias`, `fin_contas`, `fin_titulos`; módulo `financeiro`): título tipo `pagar`, `baixar`, `estornar`, `cancelar`. Use-o para lançar o acerto; **não** duplique contas a pagar.
- Cancelamento de venda: `POST /sales/:id/cancel`. Permissões em `middleware/permissions.js`; módulos em `config/modulos.js`.

## 4. Banco de dados (migration `0NN_comissoes.sql`)

- `comissao_regras` (uma por empresa; opcional por loja): `pct_padrao NUMERIC(5,2) DEFAULT 5`, `por_categoria JSONB` (`{ category_id: pct }`), `taxa_servico_repasse_pct NUMERIC(5,2) DEFAULT 100`, `base ('liquida'|'bruta') DEFAULT 'liquida'`, `meta_valor NUMERIC(12,2)`, `meta_bonus_pct NUMERIC(5,2)`, `meta_periodo ('noite'|'semana'|'mes') DEFAULT 'noite'`, `estorno_desconta BOOLEAN DEFAULT true`.
- `products.fora_da_comissao BOOLEAN DEFAULT false` (marcar no cadastro do produto).
- `users.comissao_pct NUMERIC(5,2)` (override do percentual padrão **por garçom**, opcional).
- `comissoes` (um lançamento por item/recebimento, imutável): `id, tenant_id, location_id, garcom_id, comanda_id, sale_id NULL, comanda_pagamento_id NULL, order_item_id, base_valor, pct_aplicado, valor_produtos, valor_servico, status ('pendente'|'paga'|'estornada'), acerto_id NULL, origem ('recebimento'|'fechamento'|'ajuste'|'bonus'), regra_snapshot JSONB (a regra no momento), criado_em`. Índices por `(tenant, garcom_id, status)` e `(sale_id)`.
- `comissao_acertos`: `id, tenant_id, periodo_inicio, periodo_fim, total, forma_pagamento, pago_em, pago_por, titulo_id (fin_titulos), observacao`. `comissao_acerto_itens` (acerto, garcom, valor) para o recibo por garçom.
- Ajuste manual/estorno pós-acerto: lançamento negativo (`origem 'ajuste'`, `status pendente`) que **desconta no próximo acerto** (nunca altera um acerto já pago).
- Seed: categoria financeira de despesa **"Comissões"** por empresa (como as categorias existentes do Financeiro).
- Permissão nova `Comissoes` ("Comissões: ver e gerir acertos"): Administrador `true`, Gerente `true`, demais `false` (ajustável por usuário). Entra em `areas` do módulo `garcom`. O próprio **garçom** vê **só o seu extrato** (via `Garcom`), sem precisar de `Comissoes`.

## 5. O que fazer

### 5.1 Cálculo (serviço `services/comissoes.js`, chamado dentro das transações já existentes)
- **Gatilho 1 — recebimento confirmado** (Fase 2, `receber`): para as rodadas quitadas, gere lançamentos **por item** (`order_item`): `base_valor` = valor do item (líquido se houver desconto proporcional), `pct_aplicado` = override do garçom, senão `por_categoria[categoria]`, senão `pct_padrao`; itens `fora_da_comissao` ou preço zero **não geram**. `valor_servico` = `taxa_servico` do recebimento **proporcional ao item** × `taxa_servico_repasse_pct`.
- **Gatilho 2 — fechamento da comanda** (caixa, ou `encerrar`): gere lançamentos das rodadas **não cobertas por recebimento anterior**, com o **desconto do fechamento rateado** nos itens quando `base = liquida`, e a taxa de serviço proporcional. Rodadas já comissionadas **não** geram de novo (idempotência garantida por `order_item_id` + origem; teste isso).
- **Estorno**: estornar recebimento (Fase 2) ou cancelar a venda → os lançamentos correspondentes viram `estornada` (se `pendente`) **ou** geram um lançamento **negativo pendente** (se já `paga`, quando `estorno_desconta`). O histórico nunca é apagado.
- **Bônus por meta**: ao fechar o período (`meta_periodo`), se as vendas-base do garçom ≥ `meta_valor`, gere lançamento `origem 'bonus'` de `meta_bonus_pct` sobre a base (somente uma vez por período e garçom; **calculado na consulta/acerto**, não duplicado).
- Arredondamento: calcule por item em centavos, arredonde por item e some (defina e documente; a soma por comanda deve bater com o extrato). Cubra com testes de casos limite (desconto, taxa, itens fracionados, centavos).

### 5.2 Back-end (`routes/comissoes.routes.js`)
- `GET/PUT /comissoes/regras` (`Comissoes`), validação de faixas; `PATCH /users/:id` aceita `comissao_pct` (gerência); `PATCH /products/:id` aceita `fora_da_comissao`.
- `GET /comissoes/resumo?periodo&de&ate&garcom_id&location_id` — por garçom: comandas, vendas-base, comissão sobre produtos, taxa de serviço, bônus, total, **a pagar** (pendente) e **pago**, estornos. Períodos: noite (dia comercial atual: defina o corte, ex.: a partir das 06:00; configurável), semana, mês, personalizado.
- `GET /comissoes/garcons/:id?...` — **extrato por comanda** (venda, regra aplicada, comissão, situação, comanda/mesa, hora) para conferir; inclui lançamentos negativos e diferenças de prestação de contas (Fase 2) **apenas informativas**.
- `GET /garcom/extrato` — o garçom logado vê **o próprio** extrato (comissão do dia/mês, por comanda, recebimentos na hora, dinheiro com ele); nunca vê o dos outros. (Substitui o extrato simples da Fase 1.)
- `POST /comissoes/acertos` `{ garcom_ids, periodo, forma_pagamento, lancar_financeiro: boolean, observacao }` — numa **transação**: seleciona os lançamentos `pendente` do período (inclui negativos), calcula/gera bônus devido, marca como `paga` com `acerto_id`, grava `comissao_acertos`/`itens`, e, se `lancar_financeiro`, cria título **a pagar** (categoria "Comissões", valor total, `competencia` = fim do período) **e baixa** na conta financeira escolhida (reaproveite as rotinas do Financeiro). Impede acerto duplicado do mesmo lançamento (lock + status). Total ≤ 0 → recusa.
- `GET /comissoes/acertos` e `GET /comissoes/acertos/:id` (histórico e **recibo** por garçom com os itens, para impressão/PDF no navegador: nome, período, comandas, total, linha de assinatura).
- `POST /comissoes/ajustes` `{ garcom_id, valor (±), motivo }` (gerência): lançamento manual auditado (ex.: dividir comissão entre dois garçons: negativo para um, positivo para outro).
- Auditoria (`logAudit`) em regras, ajustes, acertos e estornos; **sem** expor dados de outros garçons ao próprio garçom.

### 5.3 Front-end (seguir o preview)
- **Comissões (gestão)** (módulo `garcom`, permissão `Comissoes`; item de menu "Comissões"): filtros (período, garçom, loja), quadros **Comissão a pagar · Comissão do período · Vendas-base · Estornos**, tabela por garçom (Comandas, Vendas-base, Comissão, Taxa de serviço, Bônus, Total, Situação "a pagar R$ X"/"pago"), clique abre o **extrato por comanda** (gaveta) com ações **Transferir comanda…** (Fase 1) e **Ajuste manual…**, botão **Fechar acerto…** (modal: garçons com caixa de seleção, total, forma de pagamento/conta, "Lançar no Financeiro", "Gerar recibo") e **Exportar**. Histórico de acertos.
- **Regras** (mesma área, aba/tela "Regras e perfil"): percentual padrão, **por categoria** (liga/desliga e lista as categorias reais), taxa de serviço repassada, base, meta e bônus, estorno desconta, **simulação** (como no preview, com uma comanda real recente), e o resumo do **perfil Garçom** (o que pode e o que não pode, incluindo `ReceberNoApp`). Marcar produto **"fora da comissão"** no cadastro.
- **App do garçom**: o **Início** mostra "Comissão estimada da noite" (soma dos lançamentos do dia); **Meu extrato** com a comissão por comanda (paga/aberta/estornada), taxa de serviço repassada, bônus quando houver, **dinheiro com você** e diferenças de prestação (informativo). Texto: "A comissão conta quando o dinheiro entra; cancelamentos e estornos não contam."
- Estados vazios, erros claros e temas claro/escuro; sem rolagem horizontal em 375 px no app.

## 6. Testes obrigatórios (rodar e mostrar o resultado)

Crie `backend/scripts/e2e-garcom-fase3.mjs` e teste no navegador:

1. **Cálculo**: comanda com itens de duas categorias (percentuais diferentes), desconto no fechamento e taxa de serviço: comissão por item e total **batem com cálculo manual** (mostre a conta no relatório); arredondamento em centavos; produto `fora_da_comissao` não gera; override `users.comissao_pct` prevalece.
2. **Gatilhos**: recebimento na hora gera comissão **imediatamente** só das rodadas quitadas; o fechamento no caixa gera **só o restante**; **nada duplica** (reexecutar/reenviar não cria lançamentos extras); comanda aberta/cancelada **não** gera.
3. **Transferência de comanda** não muda o garçom dos itens já lançados; garçom B lançando itens depois recebe só os dele.
4. **Estorno** de recebimento e **cancelamento de venda** estornam os lançamentos pendentes; se já pagos em acerto, geram lançamento **negativo** que desconta no próximo acerto.
5. **Bônus por meta** aplicado uma única vez por período/garçom.
6. **Acerto**: seleção por garçom, total correto, lançamentos marcados `paga`, **não** dá para acertar o mesmo lançamento duas vezes (concorrência), título "Comissões" criado e baixado no **Financeiro** (resultado/fluxo coerentes), recibo correto.
7. **Permissões**: garçom só vê o **próprio** extrato (outro garçom → 403/404); sem `Comissoes` não acessa gestão/regras/acertos; gerente/administrador acessam.
8. Períodos (noite com corte, semana, mês) filtram corretamente (fuso do estabelecimento).
9. Isolamento entre empresas/lojas; módulo `garcom` desligado → indisponível.
10. Regressão: vendas, caixa, relatórios, financeiro, Pedidos, Fases 1 e 2, Master, modo teste e `npm run test:e2e*`; temas claro e escuro.

## 7. Fora do escopo

Folha de pagamento/encargos, gorjeta separada da taxa de serviço, comissão para outros perfis (cozinha, caixa), pagamento automático (Pix em lote), ranking público da equipe (pode ser **opcional futuro**), metas por equipe, integração com maquininha.

## 8. Ordem sugerida de commits

1. Migration (regras, `fora_da_comissao`, `comissao_pct`, `comissoes`, acertos, permissão, categoria financeira). 2. Serviço de cálculo + gatilhos de recebimento/fechamento/estorno. 3. Regras e resumo/extrato (API). 4. Acerto + Financeiro + recibo. 5. Front: Regras e "fora da comissão". 6. Front: Comissões (gestão). 7. Front: extrato e início do app do garçom. 8. e2e, temas e regressão.

## 9. Entrega

Rode os testes da seção 6 e faça um **relatório em português**: o que foi feito por commit, decisões (corte da "noite", arredondamento, bônus), **exemplos numéricos conferidos**, resultados (inclusive falhas), pendências e funcionalidades existentes que você **não removeu** mas notou conflito. Não exponha dados de outros garçons.

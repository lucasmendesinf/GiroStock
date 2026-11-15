# Prompt — Garçom, Fase 2/3: Receber na hora, pagamento dividido e prestação de contas

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Modelo visual **validado**: `docs/garcom-preview/preview-garcom.html` (folha **"Receber agora"** no app, quadro **"Dinheiro com os garçons"** e **Prestação de contas** na aba Comissões, bloco "Recebimento pelo garçom" em Regras).
> ```bash
> cd docs/garcom-preview && npx --yes serve -l 8092 .      # ou: python -m http.server 8092
> ```
> **Pré-requisito: Fase 1 concluída** (`docs/prompt-garcom-fase1-app-comandas.md`: perfil Garçom, `comandas`, rodadas como `orders`, fechamento no caixa). Confira `git log` e `ls backend/src/routes`; se faltar, **pare e avise**. Faça **somente a Fase 2**.

---

## 1. Objetivo

Permitir que o garçom **receba na hora** (ou deixe na conta e a casa cobra no fechamento), no próprio app:
1. Ao abrir a comanda: **Conta aberta** (paga no fechamento) ou **Na hora** (paga a cada rodada). Pode receber **só algumas rodadas** e deixar o resto na conta.
2. Folha **"Receber agora"**: **Pix, cartão (maquininha) e dinheiro**, taxa de serviço opcional e troco no dinheiro. **Sem integração com maquininha ou banco nesta fase**: o garçom **confirma** o recebimento (campo de integração previsto, ver 4).
3. Comanda **toda paga** → o garçom **encerra** e a venda é gerada **sem passar pelo caixa**.
4. **Dinheiro que fica com o garçom** → **prestação de contas** no caixa (conferência e baixa).
5. **Pagamento dividido**: uma venda pode ter **várias formas** de pagamento.

Decisões já tomadas (não rediscutir):
- Receber no app é **permissão à parte** (`ReceberNoApp`), por perfil **e** por usuário; **desligada por padrão** para o perfil Garçom (o gerente liga). As **formas liberadas** (Pix, cartão, dinheiro) são configuráveis por loja.
- A **taxa de serviço** é percentual configurável por loja (padrão 10%), opcional por recebimento/fechamento.
- **Dinheiro** com o garçom é permitido **por configuração** (se desligado, o garçom só recebe Pix e cartão).
- Cada recebimento fica **auditado** (quem, quando, valor, forma, comanda/rodadas).

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador em 375 px e por requisições reais; build não basta.
- Migrations: `ls backend/src/db/migrations` e use o **próximo número livre**.
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`.
- **Dinheiro e caixa são o ponto mais delicado**: um erro aqui descalibra o caixa de todas as empresas. Teste exaustivamente, em banco de **teste** (modo teste), e reporte a prova de que o **caixa esperado** continua certo.
- **Não quebre** PDV, vendas, caixa, relatórios, financeiro, Pedidos, Fase 1, Master, modo teste, suporte.
- Estilo: paleta atual, temas claro e escuro. Toda consulta filtra por `tenant_id`.

## 3. Estado atual (leia antes; confirme no código)

- `sales.forma_pagamento` é **uma só** (enum `payment_method`; `FORMAS_PAGAMENTO` em `services/vendas.js`: `pix, cartao_credito, cartao_debito, dinheiro, online`). `registrarVenda` exige `terminal_id` com **caixa aberto**.
- **Caixa esperado** (`routes/cash.routes.js`, `computeSaldoDisponivel`): valor inicial + **vendas em dinheiro da sessão** + suprimentos − sangrias. Relatórios (`routes/reports.routes.js`) e Financeiro (`routes/financeiro.routes.js`: "vendas a receber", fluxo, formas com prazo/taxa) **agrupam por `sales.forma_pagamento`**.
- `taxa_entrega` já existe em `sales` (Fase de Pedidos): use-a como **modelo** para a taxa de serviço (total, relatórios, cupom).
- Fase 1: `comandas` (`modo_pagamento 'conta'|'hora'` já gravado), rodadas = `orders` (`comanda_id`, status `entregue`), `order_items.garcom_id`, `POST /comandas/:id/fechar` (uma forma).

## 4. Banco de dados e desenho (adapte ao código real e justifique desvios)

- `comanda_pagamentos` (recebimentos): `id, tenant_id, comanda_id, location_id, valor_produtos, taxa_servico, forma ('pix'|'cartao_credito'|'cartao_debito'|'dinheiro'), recebido_por (user), recebido_em, status ('confirmado'|'estornado'), estornado_por/em/motivo, prestado_em, prestado_por, cash_session_id (prestação), diferenca_prestacao, provider TEXT NOT NULL DEFAULT 'manual', provider_ref TEXT, valor_recebido (dinheiro), troco`. Índices por comanda e por (tenant, recebido_por, prestado_em).
- `comanda_pagamento_rodadas` (`pagamento_id`, `order_id`): **quais rodadas** cada recebimento quitou (recebimento parcial por **rodada inteira**, como no preview). Uma rodada só pode estar em **um** recebimento confirmado.
- **Venda com várias formas**: nova `sale_payments` (`sale_id, forma, valor, comanda_pagamento_id NULL, recebido_por NULL, entra_no_caixa BOOLEAN`). **Compatibilidade**: `sales.forma_pagamento` continua preenchida com a **forma predominante** (maior valor; empate = a última), e **todos os relatórios/financeiro que agrupam por forma passam a ler `sale_payments`** quando existir (fallback: `sales.forma_pagamento` com o total da venda). Liste **todas** as consultas ajustadas e teste que os totais por forma batem com o total vendido.
- `sales.taxa_servico NUMERIC(12,2) DEFAULT 0`, tratada como `taxa_entrega` (compõe o total; cupom mostra a linha "Taxa de serviço").
- Configuração por loja (`locations`): `taxa_servico_pct NUMERIC DEFAULT 10`, `garcom_recebe BOOLEAN DEFAULT false`, `garcom_formas JSONB DEFAULT '{"pix":true,"cartao":true,"dinheiro":true}'`. (Se já houver tela de configuração da loja, estenda-a.)
- Nova área em `PERMISSOES`: `ReceberNoApp` ("Garçom: receber pagamentos no app"); `MATRIX`: Administrador/Gerente `true`, Garçom **`false`** (ajustável por usuário); módulo `garcom` passa a incluir essa área em `areas`.
- **Integração futura com maquininha/Pix**: `provider`/`provider_ref` ficam prontos (`'manual'` agora; futuramente `'mercadopago_point'`, `'pix_psp'`). **Não** implemente integração, mas estruture o código (um módulo `services/recebimentos.js` com uma função "confirmar recebimento") para que um provedor possa confirmar automaticamente depois.

## 5. O que fazer

### 5.1 Back-end
- `POST /garcom/comandas/:id/receber` `{ order_ids: [...], forma, cobrar_taxa: boolean, valor_recebido? }` (exige `ReceberNoApp` **e** `garcom_recebe` da loja **e** forma liberada): valida que as rodadas são da comanda, estão **entregues/ativas, não canceladas e ainda não pagas**; calcula `valor_produtos` (+ `taxa_servico` se `cobrar_taxa`); dinheiro com `valor_recebido` calcula `troco`; grava recebimento + vínculo com rodadas, em **uma transação** (`FOR UPDATE` na comanda). Resposta traz os totais. Concorrência: dois recebimentos da mesma rodada → o segundo falha (409).
- `POST /garcom/comandas/:id/receber/:pagamentoId/estornar` — **somente gerência** (`CancelarVendas`), motivo obrigatório, **somente** enquanto a comanda não estiver `paga` e (se dinheiro) antes da prestação; auditado.
- **Encerrar comanda quitada**: `POST /garcom/comandas/:id/encerrar` — só se **todas as rodadas** estão quitadas por recebimentos confirmados. Cria **uma venda** (`registrarVenda`) com todos os itens, `sale_payments` espelhando os recebimentos, `taxa_servico` somada, **sem passar pelo caixa**; baixa estoque/insumos; comanda `paga`. A venda precisa de `terminal_id` com **caixa aberto**: use o **terminal de comandas da loja** (nova config `locations.terminal_comandas_id`; se ausente, o terminal do caixa aberto da loja); **sem caixa aberto → 409** "abra o caixa para encerrar a comanda" (o recebimento já feito **não se perde**; a comanda fica "quitada, aguardando encerrar").
- **Fechamento no caixa com recebimentos parciais** (`POST /comandas/:id/fechar`, da Fase 1): passa a cobrar **só o restante** (rodadas não quitadas + taxa de serviço opcional), aceita **uma ou mais formas** (`pagamentos: [{ forma, valor }]` — o PDV pode dividir), e cria a venda com `sale_payments` = recebimentos do app + pagamentos do caixa. Total da venda = itens (todas as rodadas) + taxa − desconto (desconto **só** sobre o que ainda não foi pago; documente a regra).
- **Caixa esperado**: a parte em **dinheiro** de `sale_payments` conta no caixa **só se `entra_no_caixa = true`**. Dinheiro recebido pelo garçom entra com `entra_no_caixa = false` **até a prestação de contas**, que cria um **movimento de caixa** (suprimento com origem "prestação de contas do garçom X") na sessão aberta e passa a contar. Ajuste `computeSaldoDisponivel` e qualquer relatório de fechamento de caixa. **Prove com teste** que o esperado bate: dinheiro recebido no caixa + prestações − sangrias.
- **Prestação de contas**: `GET /garcom/prestacao` (dinheiro por garçom ainda não prestado, com comandas) e `POST /garcom/prestacao` `{ garcom_id, valor_conferido, pagamento_ids? }` (área `Vendas` com caixa aberto, ou gerência): marca `prestado_em/por`, grava `diferenca_prestacao` (sobra/falta) por recebimento proporcional ou no lote, cria o suprimento no caixa aberto e audita. Diferença **não** altera comissão; fica no extrato do garçom (Fase 3 mostra).
- **Estornos de venda**: cancelar a venda (`POST /sales/:id/cancel`) deve estornar também `sale_payments`/recebimentos (e o dinheiro já prestado vira ajuste no caixa pelo fluxo atual de cancelamento: confira que o estorno em dinheiro respeita `entra_no_caixa`).
- Auditoria (`logAudit`) em: receber, estornar recebimento, encerrar, prestação de contas, mudança de configuração de recebimento da loja.

### 5.2 Front-end do garçom (seguir o preview)
- **Nova comanda**: seletor **Conta aberta / Na hora** (Na hora desabilitado com aviso se o usuário não tem `ReceberNoApp` ou a loja desligou). Mostrar o modo na lista e na comanda.
- **Comanda "Na hora"**: o botão vira **"Enviar e receber agora"**; ao enviar a rodada abre a folha **Receber agora** (ou "Deixar na conta").
- **Qualquer comanda com rodadas não pagas e permissão**: botão **"Receber agora · R$ X"** (todas as não pagas) e, em cada rodada, ação "Receber" (parcial por rodada).
- **Folha "Receber agora"**: formas liberadas pela loja (Pix, Cartão, Dinheiro), chave "Cobrar taxa de serviço (N%)", **dinheiro**: valor recebido + troco + aviso "o dinheiro fica com você até a prestação de contas"; Pix/cartão: texto "confirme quando cair/aprovar" (sem integração); total em destaque; **Confirmar recebimento** e **Deixar na conta**. Mostrar erro do servidor (rodada já paga, caixa fechado etc.).
- Rodadas exibem **pago (forma)** ou **na conta**; o cabeçalho mostra **pago / falta**. Quando tudo está pago, o botão vira **"Encerrar comanda (tudo pago)"**.
- **Extrato do garçom**: seção **"Recebido por mim na hora"** (forma, valor, horário, **dinheiro com você** destacado, "entregue ao caixa" depois da prestação) e aviso do **dinheiro que está com ele**. (A comissão aparece só na Fase 3.)

### 5.3 Front-end de gestão/caixa
- **Configuração da loja**: "Garçom pode receber no app", formas liberadas, **taxa de serviço (%)**, terminal de comandas (em Lojas & PDVs ou na tela de configuração existente).
- **Prestação de contas** (tela para caixa/gerência): cartões **"Recebido na hora pelos garçons"**, **"Dinheiro com os garçons"** (com o botão "Receber prestação de contas…") e "Pix e cartão (já no sistema)"; modal da prestação com garçons, valor esperado, **valor conferido** e diferença; lista dos recebimentos (garçom, comanda, forma, valor, situação).
- **Fechamento no caixa** (Fase 1): mostra **o que já foi pago no app** (por forma) e cobra só o restante; permite **dividir** o restante em mais de uma forma.
- Em **Usuários**: permissão `ReceberNoApp` ajustável por usuário.

## 6. Testes obrigatórios (rodar e mostrar o resultado)

Crie `backend/scripts/e2e-garcom-fase2.mjs` e teste no navegador (375 px):

1. Sem `ReceberNoApp` ou com a loja desligada: receber → 403; "Na hora" indisponível.
2. Receber uma rodada em **Pix**, outra em **cartão**, deixar uma terceira na conta; o cabeçalho mostra pago/falta corretos; **a mesma rodada não pode ser paga duas vezes** (concorrência → 409).
3. Dinheiro com valor recebido: troco correto; recebimento fica "com o garçom" até a prestação.
4. **Encerrar comanda toda paga** sem passar pelo caixa: **uma venda**, `sale_payments` espelham os recebimentos, estoque baixado **uma vez**; sem caixa aberto → 409 e o recebimento **não se perde**.
5. **Fechar no caixa com parcial**: cobra só o restante, aceita **duas formas** (ex.: dinheiro + cartão); total da venda = itens + taxa − desconto; os relatórios **por forma** batem com o total (some `sale_payments` = soma das vendas) e o **Financeiro** (formas/prazos) continua coerente.
6. **Caixa esperado**: sessão com vendas em dinheiro no caixa + dinheiro recebido pelo garçom **antes** da prestação (não conta) e **depois** da prestação (conta como suprimento); fechar o caixa e comprovar que `valor esperado` = inicial + dinheiro (`entra_no_caixa`) + suprimentos − sangrias, com diferenças de prestação registradas.
7. **Estorno** de um recebimento (gerência, motivo): libera as rodadas; garçom não consegue; depois da prestação ou da comanda `paga` → recusado. **Cancelar a venda** estorna `sale_payments` e respeita o dinheiro.
8. Taxa de serviço: opcional por recebimento; soma correta em venda e cupom; configuração por loja.
9. Auditoria de cada ação sensível, sem dados desnecessários.
10. Isolamento entre empresas/lojas; módulo `garcom` desligado → tudo indisponível.
11. Regressão: venda direta, pedidos, PDV, caixa, relatórios, financeiro, Fase 1, Master, modo teste e `npm run test:e2e*`; temas claro e escuro; sem rolagem horizontal em 375 px.

## 7. Fora do escopo

**Integração com maquininha (Mercado Pago Point, Getnet, TEF) e geração/confirmação automática de Pix** (só os campos `provider`/`provider_ref` e o ponto de extensão), conciliação bancária, comissões (Fase 3), fila offline, gorjeta separada da taxa de serviço, divisão de conta por pessoa.

## 8. Ordem sugerida de commits

1. Migrations (`comanda_pagamentos`, vínculo com rodadas, `sale_payments`, `sales.taxa_servico`, config da loja, permissão). 2. Serviço de recebimentos + `POST receber`/estorno. 3. Venda com várias formas, ajuste de relatórios/financeiro e **caixa esperado**. 4. Encerrar comanda quitada e fechar com parcial. 5. Prestação de contas (API). 6. Front do garçom (folha, rodadas pagas, extrato). 7. Front de gestão (config, prestação, fechamento). 8. e2e, temas e regressão.

## 9. Entrega

Rode os testes da seção 6 e faça um **relatório em português**: o que foi feito por commit, decisões e **desvios do desenho**, **lista de todas as consultas de relatório/financeiro ajustadas** para `sale_payments`, prova do caixa esperado, resultados (inclusive falhas), pendências e funcionalidades existentes que você **não removeu** mas notou conflito.

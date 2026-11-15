# Prompt — Raio de entrega na loja virtual (mapa, faixas de taxa por distância e pino do cliente)

> Cole este arquivo inteiro como primeira mensagem em uma sessão do Claude Code aberta na pasta do repositório (`GiroStock`).
> Modelo visual **validado pelo cliente**: `docs/raio-preview/preview-raio.html` (mapa com o círculo do raio, faixas, pino da loja, simulador do cliente). Sirva e clique em tudo:
> ```bash
> cd docs/raio-preview && npx --yes serve -l 8088 .      # ou: python -m http.server 8088
> ```
> (O preview usa Leaflet + OpenStreetMap só para demonstração; veja na seção 5 o que fazer em produção.)

---

## 1. Objetivo

Permitir que a loja virtual (cardápio e varejo) defina a **área de entrega por raio** a partir da loja, com **taxa por faixa de distância**, e **mostrar essa cobertura num mapa** (círculo) na tela de gestão:

- Ex.: "entrego até 5 km da loja; até 2 km a taxa é R$ 4,00; de 2 a 5 km, R$ 8,00 (+10 min)".
- O cliente informa o endereço; o sistema localiza, mede a distância e responde **atende** (com taxa/tempo) ou **fora da área** (só retirada).
- Se o endereço **não for localizado** ou estiver **perto do limite**, o site **pede para o cliente marcar o pino** no mapa.

Decisões já tomadas pelo cliente (não rediscutir):
1. Distância em **linha reta** (fórmula de Haversine), não por rota.
2. **Só raio**: o novo modo **não mistura** com bairros. O modo **por bairro atual continua existindo** e é o padrão das lojas existentes (nada muda para elas); a loja escolhe **"Por bairro" ou "Por raio"**.
3. Taxa **por faixa de distância** (também existe a opção de taxa única para quem preferir).
4. Endereço não localizado → **o cliente marca o pino** no mapa.

## 2. Regras de trabalho

- Responda e **commite em português do Brasil**. Commits pequenos, um por etapa. **Não faça push.**
- Termine as mensagens de commit com a linha de coautoria que o ambiente indicar.
- Não mude o que não foi pedido. Se algo **remove funcionalidade existente**, não remova: liste no relatório final.
- Arquivos com CRLF (Windows): preserve CRLF ao editar.
- Valide no navegador (**375 px no site da loja** e desktop na gestão) e por requisições reais; build não basta.
- Antes de criar migrations: `ls backend/src/db/migrations` e use o **próximo número livre** (a última conhecida é `048_imagem_produto.sql`; outras sessões podem ter criado mais).
- Depois de qualquer `git pull`: `cd backend && npm install && npm run migrate`; o site é um projeto à parte (`cd loja && npm install && npm run build`).
- **Não quebre** a entrega por bairro, frete por transportadora (Melhor Envio), pedido mínimo, cupons, pagamento online, pedidos do site na tela Pedidos, cardápio digital, PDV, iFood/99Food, Master. Rode `backend/scripts/e2e-loja-virtual.mjs` (com simuladores) e `e2e-cardapio.mjs` (se existir) e **compare com o que passava antes**.
- **Respeite as políticas dos serviços gratuitos de mapa** (seção 5.2): identificação, limite de requisições, cache e atribuição. Nada de chamar o geocodificador em massa nem direto do navegador do cliente.
- Estilo: paleta atual, temas claro e escuro. Toda consulta filtra por `tenant_id`.

## 3. Estado atual (leia antes; confirme no código)

- Entrega local **só por bairro**: tabela `lv_regioes` (nome, taxa, `tempo_extra_min`, `pedido_minimo`), `lv_lojas.taxa_outros_bairros`, `tempo_preparo_min`, `tempo_entrega_min`, `aceita_entrega`, `pedido_minimo`. Cálculo em `backend/src/services/lojaVirtual.js` (`entregaDoBairro`, `calcularCarrinho`; trecho `if (tipo === 'entrega') { if (loja.aceita_entrega && b.bairro) … }`), com `frete.entregaLocalNaCidade` restringindo à cidade e transportadora (Melhor Envio) como alternativa por CEP.
- **Nenhuma coordenada** existe hoje: nem da loja (`lv_lojas`/`locations`), nem dos endereços (`lv_enderecos`: CEP, logradouro, número, bairro, cidade, UF), nem dos pedidos.
- Site do cliente (`loja/`): `componentes/Endereco.jsx` preenche rua/bairro/cidade pelo **ViaCEP** (no navegador); fluxo de entrega em `Finalizar`, `SacolaFolha`, `Carrinho`; API pública `backend/src/routes/loja.publica.routes.js` (`GET /loja` devolve `entrega.bairros`/`outros_bairros`, `POST /carrinho`, `POST /pedidos`, `POST /frete`, contas e endereços).
- Gestão da loja virtual: `frontend/src/pages/lojavirtual/Entrega.jsx` (lista de bairros/regiões, `RegiaoModal`), rotas administrativas em `backend/src/routes/lojaVirtual.routes.js` (`/loja-virtual/regioes`…), permissão da área `LojaVirtual`.
- Pedido do site cai na tela **Pedidos** (`orders` com `origem 'loja_virtual'`; endereço em texto, `taxa_entrega`).

## 4. Banco de dados (migrations com o próximo número livre)

- `lv_lojas`: `entrega_modo TEXT NOT NULL DEFAULT 'bairro' CHECK (entrega_modo IN ('bairro','raio'))`, `loja_lat NUMERIC(9,6)`, `loja_lng NUMERIC(9,6)`, `raio_km NUMERIC(5,1) CHECK (raio_km > 0 AND raio_km <= 60)`, `raio_usa_faixas BOOLEAN NOT NULL DEFAULT true`, `raio_taxa_unica NUMERIC(12,2) NOT NULL DEFAULT 0`, `raio_margem_pino_m INTEGER NOT NULL DEFAULT 500 CHECK (raio_margem_pino_m BETWEEN 0 AND 5000)`.
- `lv_raio_faixas`: `id, tenant_id, ate_km NUMERIC(5,1) NOT NULL, taxa NUMERIC(12,2) NOT NULL CHECK (taxa >= 0), tempo_extra_min INTEGER NOT NULL DEFAULT 0, ordem INTEGER`, único `(tenant_id, ate_km)`. **A última faixa termina exatamente no `raio_km`**; faixas em ordem crescente.
- `lv_enderecos`: `lat NUMERIC(9,6)`, `lng NUMERIC(9,6)`, `coord_origem TEXT CHECK (coord_origem IN ('cep','endereco','pino'))`.
- `orders`: `entrega_lat`, `entrega_lng`, `entrega_distancia_km NUMERIC(6,2)`, `entrega_faixa_ate_km NUMERIC(5,1)`, `entrega_coord_origem TEXT`, `entrega_aviso TEXT` (para "pino distante do CEP", ver 5.3).
- `geo_cache`: `chave_hash TEXT PRIMARY KEY, consulta TEXT, lat, lng, precisao TEXT, provedor TEXT, criado_em` (cache de geocodificação por 30 dias; **sem dados pessoais além do texto do endereço**, limpar vencidos).
- Lojas existentes ficam `entrega_modo = 'bairro'` e **nada muda** para elas.

## 5. O que fazer

### 5.1 Regra de distância e decisão (serviço puro, com testes)
`backend/src/services/raio.js`:
- `distanciaMetros(a, b)` — **Haversine** (raio da Terra 6.371 km); trabalhe em **metros inteiros** para comparar (sem erro de ponto flutuante nas bordas).
- `avaliarRaio(loja, faixas, { lat, lng, origem })` devolve `{ status, distancia_m, taxa, tempo_extra_min, faixa_ate_km }` com `status` em:
  - `'fora'`: `d > raio + margem` (**ou**, com `origem = 'pino'`, `d > raio`);
  - `'confirmar_pino'`: `origem` **diferente de `'pino'`** e `|d − raio| ≤ margem` (perto do limite, dentro ou fora);
  - `'atende'`: `d ≤ raio` (e, se a origem não for pino, fora da faixa de margem) — a **faixa** é a **primeira cuja `ate_km` ≥ d** (**borda inclusiva**); sem faixas → `raio_taxa_unica`;
  - `'pedir_pino'`: quando o endereço **não foi localizado** (sem coordenadas).
- Margem `0` desliga a faixa de "perto do limite". Valide coordenadas (lat −35..6, lng −75..−30 para o Brasil; fora disso → 400).

### 5.2 Localização de endereços e mapa (servidor)
- `backend/src/services/geocodificacao.js` com **provedor plugável por variável de ambiente** (`GEOCODER`):
  - `simulado` (padrão em desenvolvimento/testes): tabela fixa de CEPs/endereços de teste, **sem rede**; recusado em produção.
  - **`publico`** (BrasilAPI CEP v2 → coordenadas **quando existirem** + Nominatim/OpenStreetMap como segunda tentativa por endereço): **obedeça a política de uso do Nominatim**: cabeçalho **`User-Agent` identificando a aplicação e um contato** (variável `GEOCODER_USER_AGENT`, **obrigatória em produção**; sem ela o provedor fica **desativado com status claro**, nunca com um agente genérico), **no máximo 1 requisição por segundo no total** (fila/limitador global no servidor), **cache** em `geo_cache` (30 dias), sem consultas em massa nem automáticas repetidas.
  - **`http`** genérico: URL/cabeçalho/formato configuráveis por ambiente para plugar um provedor pago (Google, Mapbox, OpenCage…) sem mexer no código.
- Falha, limite ou endereço não encontrado **nunca** bloqueia o pedido: devolve `localizado: false` e o site cai em **"pedir o pino"**.
- Mapa de fundo (site e gestão): URL de tiles por ambiente (`MAPA_TILES_URL`, `MAPA_ATRIBUICAO`), exposta em `GET /loja` e nas rotas administrativas; **o padrão em desenvolvimento é o do OpenStreetMap**, com **atribuição visível**; o relatório deve **alertar** que a política dos tiles do OpenStreetMap **não permite uso pesado** e que, em produção com tráfego real, é preciso configurar um provedor de mapas (MapTiler, Mapbox, Stadia…) ou servidor próprio de tiles.
- Status das integrações (provedor de geocodificação e de mapa **configurados ou não**, sem segredos) aparece no painel **Master › Configurações globais › Integrações**, no padrão das outras.

### 5.3 API pública e pedido (`/api/loja/v1`)
- `GET /loja`: quando `entrega_modo = 'raio'`, `entrega` traz `{ modo: 'raio', raio_km, faixas: [{ ate_km, taxa, tempo_estimado_min }], margem_pino_m, loja: { lat, lng }, mapa: { tiles_url, atribuicao } }` (a posição da loja é a do endereço já público); `entrega.bairros` **não** é usado nesse modo.
- **Novo** `POST /entrega/localizar` `{ cep, numero?, logradouro?, bairro?, cidade?, uf? }` com **limite de requisições por IP** (`limitar(...)` como as outras rotas) → `{ localizado, lat, lng, origem: 'cep'|'endereco', status, distancia_km, taxa, tempo_extra_min, faixa_ate_km }`, já com a **decisão** de `avaliarRaio`.
- `POST /carrinho` e `POST /pedidos` aceitam `entrega: { lat, lng, origem: 'cep'|'endereco'|'pino' }` (e o endereço de texto de sempre). **O servidor recalcula tudo** (distância, faixa, taxa, tempo) e **ignora** qualquer taxa/faixa/distância enviada pelo cliente. Respostas: **422** "fora da área de entrega" (sugerindo retirada), **422** `status: 'confirmar_pino'`/`'pedir_pino'` quando o site precisa do pino (sem erro genérico), e o cálculo normal quando `atende`. Coordenadas inválidas → 400.
- Antifraude leve: guarde no pedido `entrega_lat/lng`, `entrega_distancia_km`, `entrega_faixa_ate_km`, `entrega_coord_origem`. Se o cliente enviar um **pino** a **mais de 3 km** do ponto geocodificado do endereço informado, **aceite** (pode ser legítimo), mas grave `entrega_aviso = 'pino distante do endereço informado (X km)'` para o operador ver em Pedidos.
- Endereços salvos (`/conta/enderecos`) guardam `lat/lng/coord_origem`: um cliente recorrente **não precisa marcar o pino de novo**; ao editar o endereço, as coordenadas são recalculadas.
- `entrega_modo = 'bairro'`: **comportamento atual idêntico** (inclusive `bairro`, `outros_bairros`, cidade). Em `'raio'` o filtro `entregaLocalNaCidade` **não se aplica** (o raio define a área); a **transportadora** (Melhor Envio), se ativa, continua como alternativa **fora do raio** e coexiste na mesma tela.
- Retirada nunca depende do raio.

### 5.4 Gestão (`Entrega.jsx`) — seguir o preview
- Seletor **"Como a loja entrega: Por bairro (atual) | Por raio"**; "Por bairro" mostra a tela de hoje; "Por raio" mostra:
  - **Local da loja**: campo de endereço + **Buscar** (rota administrativa `GET /loja-virtual/geocodificar?q=`, mesma geocodificação do servidor, com os mesmos limites) e **pino arrastável** no mapa; coordenadas exibidas.
  - **Raio** (barra + campo, 0,5 a 60 km; padrão 5) com **círculo no mapa** que se ajusta em tempo real e **enquadra** a visão; área em km².
  - **Faixas de taxa**: tabela "Até (km) · Taxa · + min" com **círculos coloridos concêntricos**, **+ faixa**, remover, **a última faixa sempre = raio** (trava no campo); opção de **taxa única**; validações (crescentes, taxa ≥ 0, `ate_km` > 0).
  - **"Perto do limite, pedir para o cliente confirmar o pino"**: metros (padrão 500), com as **linhas tracejadas** no mapa (limite ± margem).
  - **Simulador do cliente**: clicar no mapa chama o **servidor** (`POST /loja-virtual/raio/simular` `{ lat, lng, origem }`, **a mesma função** `avaliarRaio`) e mostra "✔ Entregamos aqui · taxa/tempo/faixa", "⚠ perto do limite — confirmar pino" ou "✖ fora da área"; alternância "Endereço localizado pelo CEP | Não localizado (cliente marca o pino)".
  - **Resumo** textual da cobertura.
- Salvar valida e audita (`logAudit`, antes/depois). Sem coordenadas da loja → não deixa ativar o modo raio.
- Biblioteca de mapa: **Leaflet** (dependência `leaflet` nos projetos `frontend/` e `loja/`), tema escuro com filtro nos tiles como no preview; atribuição sempre visível.

### 5.5 Site do cliente (`loja/`)
- No modo raio, o formulário de entrega pede **CEP e número**; ao completar, chama `POST /entrega/localizar` e mostra, **antes de pagar**, o resultado: taxa e tempo; **"fora da área"** com botão **"Trocar para retirada"**; ou **"Confirme o local no mapa"**.
- **Folha "Confirme o local da entrega"** (carregada **sob demanda**, chunk separado para não inflar o site): mapa com o pino **arrastável** já posicionado onde o sistema localizou (ou no centro da cidade se não localizou), texto "Arraste o pino até o local exato" e botão **Confirmar local**; ao confirmar (`origem: 'pino'`), recalcula pelo servidor. Mostra o **raio** como círculo discreto para o cliente entender o limite. Acessível por teclado/leitor (campos de endereço continuam funcionando sem o mapa).
- O cardápio digital (sacola) e o varejo usam o **mesmo componente**; o resumo do pedido mostra a taxa por faixa. Se a geocodificação estiver indisponível, **vai direto para o pino**.
- Cliente logado reutiliza as coordenadas do endereço salvo.

### 5.6 Tela Pedidos (operador)
Pedido de entrega por raio mostra "**Entrega: 3,2 km · faixa até 5 km · local marcado pelo cliente**" (ou "localizado pelo CEP"), o `entrega_aviso` (se houver) e **link "Abrir no mapa"** (`https://www.google.com/maps?q=lat,lng` ou `geo:`). Nada mais muda no fluxo do pedido.

## 6. Testes obrigatórios (rodar e mostrar o resultado)

Crie `backend/scripts/e2e-raio-entrega.mjs` (padrão dos e2e; provedor `simulado`) e teste no navegador (375 px no site e desktop na gestão):

1. **Haversine/avaliação (unitário)**: distâncias conhecidas (ex.: 1 km, 5 km exatos em metros); **borda inclusiva** (exatamente 5.000 m atende, 5.001 m dentro da margem pede pino); faixas (1 km → faixa 1, 3 km → faixa 2); `raio_taxa_unica`; margem 0; coordenadas fora do Brasil → 400; sem erro de ponto flutuante.
2. **Configuração**: salvar raio/faixas/margem; validações (raio > 0, faixas crescentes, **última = raio**, taxa ≥ 0, `ate_km` repetido → 409); mudar o raio **reajusta a última faixa**; sem coordenadas da loja não ativa o modo; só quem tem `LojaVirtual`; auditoria.
3. **Servidor é a verdade**: pedido com `taxa`/`faixa`/`distancia` adulterados no corpo → ignorados e recalculados; coordenadas adulteradas para dentro do raio **sem** passar pelo pino/geocodificação coerente → aceito só como `origem: 'pino'` (com `entrega_aviso` se > 3 km do endereço); fora do raio → **422**; perto do limite com origem CEP → 422 `confirmar_pino`; não localizado → `pedir_pino`.
4. **Pedido ponta a ponta**: dentro da faixa 1, dentro da faixa 2, perto do limite → pino → atende, perto do limite → pino fora → fora; o pedido grava distância/faixa/origem; **taxa na venda/relatórios** correta; aparece em Pedidos com a linha de entrega e o link do mapa.
5. **Geocodificação**: provedor `simulado` (CEP conhecido/desconhecido); **cache** (segunda consulta igual não chama o provedor); **limitador de 1 req/s** (provedor `http` simulado chamado em rajada → nunca mais de 1/s); **`User-Agent` obrigatório em produção** (`GEOCODER=publico` sem `GEOCODER_USER_AGENT` → desativado com status claro, não faz a chamada); falha do provedor → `pedir_pino`, sem derrubar o pedido; `simulado` recusado com `NODE_ENV=production`.
6. **Compatibilidade**: loja em `'bairro'` **idêntica** ao comportamento anterior (bairros, outros bairros, cidade, pedido mínimo por bairro); **transportadora** coexiste fora do raio; retirada independe do raio; cupom, pedido mínimo e pagamento online seguem funcionando; endereço salvo reutiliza coordenadas.
7. **Isolamento**: uma empresa não vê/edita a configuração de outra; `geo_cache` não vaza dados de outra empresa (a chave é o texto do endereço, mas **nunca devolva consultas de outro tenant** na gestão).
8. **Telas**: gestão (círculos, faixas, linhas tracejadas, simulador chamando o servidor, tema claro/escuro, 375 px sem rolagem horizontal da página) e site (digitar CEP → resultado; fora da área → retirada; folha do pino arrastável; chunk do mapa só carrega quando necessário; teclado/leitor).
9. **Regressão**: `e2e-loja-virtual` (com simuladores), `e2e-cardapio` (se existir), `e2e-financeiro`, `e2e-relatorios`, pedidos/garçom/clientes e `e2e-modulos` — **compare com a execução anterior** (algumas verificações de site por domínio/rastreio já falhavam em ambiente local antes deste trabalho).

## 7. Fora do escopo

Distância por **rota** de carro; **polígonos** desenhados à mão e áreas por **bairro + raio** (decisão: só raio); vários raios por loja ou várias lojas no mesmo site; pedido manual do operador em **Pedidos/PDV** com raio (pode ser etapa futura); preço por distância contínuo (km a km); rastreamento do entregador; compra/contrato do provedor de mapas/geocodificação (a escolha e a chave são do cliente).

## 8. Ordem sugerida de commits

1. Migrations + `services/raio.js` com testes unitários. 2. Serviço de geocodificação (simulado, público com política, http) + cache + status no Master. 3. Rotas administrativas (configuração, geocodificar, simular) com validações e auditoria. 4. API pública (`GET /loja`, `/entrega/localizar`, `/carrinho` e `/pedidos` por raio, coordenadas nos endereços e no pedido). 5. Gestão: mapa, raio, faixas, simulador. 6. Site: formulário por CEP, resultado, retirada e folha do pino. 7. Tela Pedidos (linha de entrega e link do mapa). 8. e2e novo, temas, regressão.

## 9. Entrega

Rode os testes da seção 6 e faça um **relatório em português**: o que foi feito por commit, decisões e **desvios do desenho** (com o motivo), **como configurar** `GEOCODER`, `GEOCODER_USER_AGENT`, `MAPA_TILES_URL` e `MAPA_ATRIBUICAO` (**sem repetir segredos**), o **alerta sobre os limites dos serviços gratuitos** (Nominatim e tiles do OpenStreetMap) e o que contratar antes de abrir para tráfego real, resultados (inclusive falhas e o que já falhava antes), pendências e funcionalidades existentes que você **não removeu** mas notou conflito. Inclua capturas de tela da gestão e do site (375 px).

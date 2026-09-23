# GiroStock — Etapa 2 (Estrutura Principal + PDV)

Sistema de gestão da JA Conveniência (Calutec Soluções). Esta etapa implementa cadastros de base, estoque multi-local, ficha técnica de insumos, PDV e controle de caixa.

## Stack

- Frontend: React + Vite (PWA)
- Backend: Node.js + Express (API REST)
- Banco: PostgreSQL
- Cache/filas: Redis
- Proxy: Nginx
- Containers: Docker + Docker Compose

## Subindo o ambiente

```bash
cd backend
cp .env.example .env

cd ..
docker compose up -d --build
docker compose exec api npm run migrate
docker compose exec api npm run seed
```

Acesse:

- App completo via Nginx: http://localhost:8080
- API direta: http://localhost:3000
- Frontend (dev, sem Docker): `cd frontend && npm install && npm run dev`

## Login de exemplo (gerado pelo seed)

- E-mail: `admin@girostock.local`
- Senha: `admin123`

## Estrutura

```
backend/   API Node.js + PostgreSQL (migrations em src/db/migrations)
frontend/  PWA React (telas: PDV, Produtos & Estoque, Insumos, Fornecedores, Usuários, Relatórios)
nginx/     Proxy reverso
```

## Regras de negócio centrais

- Multi-tenant desde a base: toda tabela relevante tem `tenant_id`.
- Estoque de produto por local (`stock_balances`), toda alteração passa por `stock_movements`.
- Venda com ficha técnica valida e debita insumos e produto na mesma transação de banco (tudo ou nada).
- Não é possível vender com o caixa fechado.
- Sangria nunca deixa o saldo esperado do caixa negativo.
- Auditoria (`audit_logs`) registra alterações relevantes de estoque, preço, caixa e permissões.

Consulte [REGRAS_E_ETAPAS.md](REGRAS_E_ETAPAS.md) para o escopo completo do projeto.

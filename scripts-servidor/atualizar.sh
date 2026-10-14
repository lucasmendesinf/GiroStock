#!/bin/bash
# Atualizacao automatica da producao (roda pelo Cron do cPanel, ex.: a cada 5 minutos).
# Puxa a branch "producao" do GitHub; se houver novidade: atualiza o codigo, instala dependencias (so se o package-lock mudou),
# aplica migracoes e reinicia o app. Nada acontece se nao houver commit novo. .env, node_modules e backups NAO sao tocados.
# Falha em qualquer passo = para ali e o app continua rodando a versao anterior (veja o log).
APP="/home/calutecc/repositories/GiroStock"
VENV="/home/calutecc/nodevenv/repositories/GiroStock/backend/22/bin/activate"
LOG="/home/calutecc/logs/deploy-girostock.log"
mkdir -p "$(dirname "$LOG")"

exec 9>/tmp/girostock-deploy.lock
flock -n 9 || exit 0   # ja tem uma atualizacao em andamento

set -e
cd "$APP"
git fetch -q origin producao
ATUAL=$(git rev-parse HEAD 2>/dev/null || echo nenhum)
NOVO=$(git rev-parse origin/producao)
[ "$ATUAL" = "$NOVO" ] && exit 0

echo "[$(date '+%F %T')] atualizando ${ATUAL:0:7} -> ${NOVO:0:7}" >> "$LOG"
LOCK_ANTES=$(git rev-parse "HEAD:backend/package-lock.json" 2>/dev/null || echo nenhum)
git reset -q --hard origin/producao
LOCK_DEPOIS=$(git rev-parse "HEAD:backend/package-lock.json")

cd backend
# shellcheck disable=SC1090
source "$VENV"
if [ "$LOCK_ANTES" != "$LOCK_DEPOIS" ]; then
  echo "[$(date '+%T')] npm install (dependencias mudaram)" >> "$LOG"
  npm install --omit=dev >> "$LOG" 2>&1
fi
node src/db/migrate.js >> "$LOG" 2>&1
mkdir -p tmp && touch tmp/restart.txt
echo "[$(date '+%T')] ok: app reiniciado em ${NOVO:0:7}" >> "$LOG"

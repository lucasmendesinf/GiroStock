// Monitoramento leve para o painel Master. Tudo aqui e barato e NUNCA derruba a requisicao se falhar.
//  - Contador de requisicoes por minuto: anel em memoria (60 baldes); reiniciar o processo zera.
//  - Captura de erros 5xx em erros_sistema (retencao de 30 dias, limpeza diaria).
//  - "Ultimo acesso" do usuario, gravado no maximo 1x por minuto por usuario.
const pool = require('../db/pool');

const MINUTO = 60 * 1000;
const baldes = new Array(60).fill(0);
let minutoAtual = Math.floor(Date.now() / MINUTO);

function girarAte(agora) {
  const m = Math.floor(agora / MINUTO);
  if (m === minutoAtual) return;
  const passos = Math.min(60, m - minutoAtual);
  for (let i = 1; i <= passos; i += 1) baldes[(minutoAtual + i) % 60] = 0;
  minutoAtual = m;
}

// Middleware: conta cada requisicao /api (1 incremento em memoria).
function contarRequisicao(req, res, next) {
  girarAte(Date.now());
  baldes[minutoAtual % 60] += 1;
  next();
}

// Ultimos 60 minutos (mais antigo primeiro) e o pico.
function requisicoesPorMinuto() {
  girarAte(Date.now());
  const serie = [];
  for (let i = 59; i >= 0; i -= 1) serie.push(baldes[(minutoAtual - i + 60 * 2) % 60]);
  return { serie, pico: Math.max(...serie), ultimoMinuto: serie[59] };
}

// Remove dados que nao devem ficar gravados: e-mails, tokens/JWT, valores de senha/segredo, sequencias longas.
function sanearMensagem(texto) {
  return String(texto || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]')
    .replace(/(senha|password|passwd|secret|segredo|token|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[oculto]')
    .replace(/postgres(ql)?:\/\/\S+/gi, '[url-banco]')
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '[oculto]')
    .slice(0, 300);
}

// Padrao da rota: /api/orders/:id em vez do caminho real; sem query string.
function padraoDaRota(req) {
  const base = (req.baseUrl || '') + (req.route && req.route.path ? req.route.path : '');
  const bruto = base && req.route ? base : (req.path || req.originalUrl || '').split('?')[0];
  return String(bruto).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\/\d+(?=\/|$)/g, '/:n').slice(0, 200);
}

// Grava um erro 5xx. Qualquer falha aqui e engolida (nao pode gerar novo erro).
async function registrarErro(req, status, err) {
  try {
    const u = req.user || {};
    await pool.producao.query(
      `INSERT INTO erros_sistema (metodo, rota, status, mensagem, tenant_id, usuario_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [String(req.method || '').slice(0, 10), padraoDaRota(req), status, sanearMensagem(err && err.message), u.tenantId || null, u.id || null]
    );
  } catch (e) { /* silencioso de proposito */ }
}

const ultimaGravacao = new Map();
// Chamado pelo authRequired sem await: nunca bloqueia a requisicao.
function marcarAcesso(userId) {
  const agora = Date.now();
  const antes = ultimaGravacao.get(userId) || 0;
  if (agora - antes < MINUTO) return;
  ultimaGravacao.set(userId, agora);
  if (ultimaGravacao.size > 5000) ultimaGravacao.clear();
  pool.producao.query(`UPDATE users SET ultimo_acesso = now() WHERE id = $1`, [userId]).catch(() => {});
}

let timerLimpeza = null;
// Retencao de 30 dias dos erros. Roda ao iniciar e depois 1x por dia.
function iniciarLimpezaDiaria() {
  if (timerLimpeza) return;
  const limpar = () => pool.producao.query(`DELETE FROM erros_sistema WHERE criado_em < now() - interval '30 days'`).catch(() => {});
  setTimeout(limpar, 30 * 1000).unref();
  timerLimpeza = setInterval(limpar, 24 * 60 * MINUTO);
  timerLimpeza.unref();
}

module.exports = { contarRequisicao, requisicoesPorMinuto, registrarErro, sanearMensagem, padraoDaRota, marcarAcesso, iniciarLimpezaDiaria };

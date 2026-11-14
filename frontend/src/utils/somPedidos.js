// Sons de pedido novo, um para cada origem (gerados no navegador, sem arquivo de audio):
// - Loja virtual: "plim-plom" suave, como campainha (duas notas descendo e subindo);
// - iFood: tres bipes agudos e rapidos;
// - 99Food: "tu-du tu-du" (duas notas subindo, repetidas).
// O navegador so libera o som depois de um clique/tecla na pagina: destravarSom() roda no primeiro clique.
let ctx = null;
const CHAVE_MUDO = 'girostock_som_pedidos';

function contexto() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!ctx) ctx = new Ctx();
  return ctx;
}

export function somLiberado() {
  return !!ctx && ctx.state === 'running';
}

export function destravarSom() {
  const c = contexto();
  if (c && c.state === 'suspended') return c.resume().catch(() => {});
  return Promise.resolve();
}

export function somLigado() {
  try { return localStorage.getItem(CHAVE_MUDO) !== 'desligado'; } catch { return true; }
}
export function ligarSom(sim) {
  try { localStorage.setItem(CHAVE_MUDO, sim ? 'ligado' : 'desligado'); } catch { /* sem armazenamento */ }
  window.dispatchEvent(new Event('girostock:som-pedidos'));
}

function nota(c, { freq, inicio, dur, tipo = 'sine', volume = 0.22, ate = null }) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = tipo;
  o.frequency.setValueAtTime(freq, c.currentTime + inicio);
  if (ate) o.frequency.exponentialRampToValueAtTime(ate, c.currentTime + inicio + dur);
  g.gain.setValueAtTime(0.0001, c.currentTime + inicio);
  g.gain.exponentialRampToValueAtTime(volume, c.currentTime + inicio + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + inicio + dur);
  o.connect(g);
  g.connect(c.destination);
  o.start(c.currentTime + inicio);
  o.stop(c.currentTime + inicio + dur + 0.02);
}

const SONS = {
  // campainha: mi agudo -> do, depois sol (sino suave, notas longas)
  loja_virtual: (c) => {
    nota(c, { freq: 1318.5, inicio: 0, dur: 0.45, volume: 0.2 });
    nota(c, { freq: 1046.5, inicio: 0.22, dur: 0.55, volume: 0.2 });
    nota(c, { freq: 1568, inicio: 0.5, dur: 0.7, volume: 0.16 });
  },
  // tres bipes agudos, curtos e secos
  ifood: (c) => {
    [0, 0.16, 0.32].forEach((t) => nota(c, { freq: 1760, inicio: t, dur: 0.1, tipo: 'square', volume: 0.09 }));
  },
  // "tu-du tu-du": notas subindo, timbre mais grave
  '99food': (c) => {
    [0, 0.45].forEach((t) => {
      nota(c, { freq: 523.3, inicio: t, dur: 0.16, tipo: 'triangle', volume: 0.32 });
      nota(c, { freq: 784, inicio: t + 0.17, dur: 0.22, tipo: 'triangle', volume: 0.32 });
    });
  },
};

// Toca o som da origem (loja_virtual | ifood | 99food). Devolve false se o navegador ainda nao liberou o som.
export function tocarSomPedido(origem, { forcar = false } = {}) {
  if (!forcar && !somLigado()) return true;
  const c = contexto();
  if (!c) return false;
  if (c.state !== 'running') { c.resume().catch(() => {}); return false; }
  try { (SONS[origem] || SONS.loja_virtual)(c); } catch { /* sem audio */ }
  return true;
}

export function requestFullscreen() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (!fn) return;
  try {
    const result = fn.call(el);
    if (result && result.catch) result.catch(() => {});
  } catch {
    // navegador bloqueou (ex: sem gesto do usuario) — ignora
  }
}

export function exitFullscreen() {
  if (!isFullscreen()) return;
  const fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (!fn) return;
  try {
    const result = fn.call(document);
    if (result && result.catch) result.catch(() => {});
  } catch {
    // ja fora da tela cheia ou navegador bloqueou — ignora
  }
}

export function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
}

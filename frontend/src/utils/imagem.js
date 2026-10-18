// Fotos da loja virtual: reduz no navegador (lado maior ate `max` px, JPEG/WebP ~85%) antes de enviar,
// para a foto chegar leve ao site (e o envio caber no limite de 2 MB do servidor).
export async function reduzirImagem(arquivo, max = 1200) {
  if (!/^image\/(jpeg|png|webp)$/.test(arquivo.type)) throw new Error('use uma foto JPG, PNG ou WebP');
  const url = URL.createObjectURL(arquivo);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('não foi possível abrir a foto'));
      i.src = url;
    });
    const escala = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * escala);
    const h = Math.round(img.naturalHeight * escala);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // PNG com transparencia vira fundo branco no JPEG
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const tipo = arquivo.type === 'image/png' && escala === 1 && arquivo.size < 1500000 ? null : 'image/jpeg';
    if (!tipo) return arquivo; // PNG pequeno (ex.: logo com transparencia): vai como esta
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), tipo, 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Envia a foto (corpo binario) e devolve { id, url }.
export async function enviarImagem(arquivo, max) {
  const blob = await reduzirImagem(arquivo, max);
  const token = localStorage.getItem('girostock_token');
  const res = await fetch('/api/loja-virtual/imagens', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'image/jpeg', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: blob,
  });
  const dados = await res.json().catch(() => null);
  if (!res.ok) throw new Error((dados && dados.erro) || `Erro ${res.status}`);
  return dados;
}

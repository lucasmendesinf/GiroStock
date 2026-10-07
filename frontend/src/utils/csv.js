// Exportacao CSV para Excel brasileiro: separador ";", UTF-8 com BOM e decimais com virgula.
const aspas = (v) => {
  const t = v === null || v === undefined ? '' : String(v);
  return /[";\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export const numeroCsv = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? '' : String(Number(v)).replace('.', ','));

export function baixarCsv(nomeArquivo, cabecalho, linhas) {
  const corpo = [cabecalho, ...linhas].map((l) => l.map(aspas).join(';')).join('\r\n');
  const blob = new Blob(['﻿', corpo], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

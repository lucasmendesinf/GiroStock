// Tabelas com a classe "tabela-cartoes" viram cartoes no celular (CSS): cada celula ganha o nome da sua coluna
// (data-label, tirado do cabecalho) para aparecer ao lado do valor. Observa a pagina e rotula as linhas novas.
function rotular(tabela) {
  const nomes = [...tabela.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  for (const tr of tabela.querySelectorAll('tbody tr')) {
    [...tr.children].forEach((td, i) => {
      const nome = td.colSpan > 1 ? '' : nomes[i] || '';
      if (td.getAttribute('data-label') !== nome) td.setAttribute('data-label', nome);
    });
  }
}

export function iniciarTabelasCartoes() {
  if (typeof MutationObserver === 'undefined') return;
  let agendado = false;
  const rodar = () => { agendado = false; document.querySelectorAll('table.tabela-cartoes').forEach(rotular); };
  new MutationObserver(() => { if (!agendado) { agendado = true; requestAnimationFrame(rodar); } })
    .observe(document.body, { childList: true, subtree: true, characterData: true });
}

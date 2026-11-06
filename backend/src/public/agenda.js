/* Agenda de eventos do GiroStock para colar em qualquer site.
 *
 *   <div id="agenda-eventos"></div>
 *   <script src="https://girostock.calutec.com.br/agenda.js" data-chave="ag_..." data-alvo="#agenda-eventos" defer></script>
 *
 * Opcoes (atributos do <script>):
 *   data-chave   chave da agenda (GiroStock > Eventos > Agenda no site)          [obrigatorio]
 *   data-alvo    onde mostrar (seletor CSS); sem ele, logo depois do <script>
 *   data-limite  quantos eventos (padrao 6)
 *   data-tema    "escuro" (fundo escuro), "claro" ou "auto" (padrao: auto, segue o fundo do site)
 *   data-cor     cor de destaque (padrao #f0b429)
 *   data-estilo  "nenhum" = sem o visual pronto, so o HTML com as classes ga-* para o site estilizar
 *   data-vazio   texto quando nao houver evento (padrao "Nenhum evento agendado no momento.")
 */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var d = script.dataset || {};
  var chave = d.chave;
  var origem = new URL(script.src, location.href).origin;
  var limite = Number(d.limite) || 6;
  var cor = d.cor || '#f0b429';
  var vazio = d.vazio || 'Nenhum evento agendado no momento.';
  var semEstilo = d.estilo === 'nenhum';

  var alvo = d.alvo ? document.querySelector(d.alvo) : null;
  if (!alvo) {
    alvo = document.createElement('div');
    script.parentNode.insertBefore(alvo, script.nextSibling);
  }
  alvo.classList.add('ga');

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function brl(v) { return 'R$ ' + Number(v).toFixed(2).replace('.', ','); }
  function escuroAuto() {
    var el = alvo;
    while (el && el !== document.documentElement) {
      var bg = getComputedStyle(el).backgroundColor;
      var m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
      if (m && (m[4] === undefined || Number(m[4]) > 0.3)) return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) < 128;
      el = el.parentElement;
    }
    return false;
  }

  if (!semEstilo && !document.getElementById('ga-estilo')) {
    var css = document.createElement('style');
    css.id = 'ga-estilo';
    css.textContent = [
      '.ga{--ga-cor:' + cor + ';--ga-txt:#16181d;--ga-sub:#5f636b;--ga-card:#fff;--ga-linha:rgba(0,0,0,.1);font-family:inherit}',
      '.ga.ga-escuro{--ga-txt:#fff;--ga-sub:rgba(255,255,255,.72);--ga-card:rgba(255,255,255,.08);--ga-linha:rgba(255,255,255,.16)}',
      '.ga-lista{display:grid;gap:12px}',
      '.ga-ev{display:grid;grid-template-columns:auto 1fr;gap:14px;padding:14px;border-radius:14px;background:var(--ga-card);border:1px solid var(--ga-linha);color:var(--ga-txt);text-align:left}',
      '.ga-ev.ga-com-foto{grid-template-columns:96px 1fr}',
      '.ga-foto{width:96px;height:96px;border-radius:10px;object-fit:cover;display:block}',
      '.ga-data{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:58px;height:62px;border-radius:10px;background:var(--ga-cor);color:#16181d;line-height:1}',
      '.ga-data b{font-size:24px;font-weight:900}.ga-data small{font-size:12px;font-weight:800;text-transform:uppercase;margin-top:3px}',
      '.ga-info{min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.ga-quando{color:var(--ga-cor);font-weight:800;font-size:13px}',
      '.ga-nome{margin:0;font-size:18px;font-weight:800;color:var(--ga-txt)}',
      '.ga-atr,.ga-desc{margin:0;color:var(--ga-sub);font-size:14px}',
      '.ga-desc{display:none;white-space:pre-line}.ga-ev.ga-aberto .ga-desc{display:block}',
      '.ga-acoes{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;align-items:center}',
      '.ga-btn{display:inline-block;padding:8px 14px;border-radius:999px;font-size:13px;font-weight:800;text-decoration:none;cursor:pointer;border:1px solid var(--ga-cor);background:var(--ga-cor);color:#16181d}',
      '.ga-btn.ga-sec{background:transparent;color:var(--ga-txt);border-color:var(--ga-linha)}',
      '.ga-preco{font-weight:800;color:var(--ga-txt);font-size:14px}',
      '.ga-agora{display:inline-block;padding:2px 8px;border-radius:999px;background:#25d366;color:#fff;font-size:11px;font-weight:800;margin-left:6px;vertical-align:middle}',
      '.ga-vazio{padding:24px;border:1px dashed var(--ga-linha);border-radius:14px;text-align:center;color:var(--ga-sub)}',
      '@media(max-width:520px){.ga-ev.ga-com-foto{grid-template-columns:1fr}.ga-foto{width:100%;height:160px}}',
    ].join('\n');
    document.head.appendChild(css);
  }

  function cartao(e) {
    var diaSemana = e.dia_semana.charAt(0).toUpperCase() + e.dia_semana.slice(1);
    var quando = diaSemana + ', ' + e.data.slice(0, 5) + ' · ' + e.hora + (e.hora_fim ? ' às ' + e.hora_fim : '');
    var texto = e.nome + ' — ' + e.dia_semana + ', ' + e.data.slice(0, 5) + ' às ' + e.hora + (e.link_ingresso ? '\nIngressos: ' + e.link_ingresso : '') + '\n' + location.href.split('#')[0];
    return '<article class="ga-ev' + (e.imagem ? ' ga-com-foto' : '') + '" data-id="' + esc(e.id) + '">' +
      (e.imagem ? '<img class="ga-foto" src="' + esc(e.imagem) + '" alt="" loading="lazy">' : '<div class="ga-data"><b>' + esc(e.dia) + '</b><small>' + esc(e.mes) + '</small></div>') +
      '<div class="ga-info">' +
      '<span class="ga-quando">' + esc(quando) + (e.em_andamento ? '<span class="ga-agora">acontecendo agora</span>' : '') + '</span>' +
      '<h3 class="ga-nome">' + esc(e.nome) + '</h3>' +
      (e.atracoes ? '<p class="ga-atr">' + esc(e.atracoes) + '</p>' : '') +
      (e.descricao ? '<p class="ga-desc">' + esc(e.descricao) + '</p>' : '') +
      '<div class="ga-acoes">' +
      (e.preco_ingresso != null ? '<span class="ga-preco">' + (e.preco_ingresso > 0 ? 'Ingresso ' + brl(e.preco_ingresso) : 'Entrada gratuita') + '</span>' : '') +
      (e.link_ingresso ? '<a class="ga-btn" href="' + esc(e.link_ingresso) + '" target="_blank" rel="noopener">Comprar ingresso</a>' : '') +
      (e.descricao ? '<button type="button" class="ga-btn ga-sec ga-mais">Detalhes</button>' : '') +
      '<a class="ga-btn ga-sec" href="https://wa.me/?text=' + encodeURIComponent(texto) + '" target="_blank" rel="noopener">Compartilhar</a>' +
      '</div></div></article>';
  }

  function mostrar(eventos) {
    if (!semEstilo && (d.tema === 'escuro' || (d.tema !== 'claro' && escuroAuto()))) alvo.classList.add('ga-escuro');
    alvo.innerHTML = eventos.length ? '<div class="ga-lista">' + eventos.map(cartao).join('') + '</div>' : '<div class="ga-vazio">' + esc(vazio) + '</div>';
    alvo.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('.ga-mais');
      if (!b) return;
      var card = b.closest('.ga-ev');
      card.classList.toggle('ga-aberto');
      b.textContent = card.classList.contains('ga-aberto') ? 'Fechar' : 'Detalhes';
    });
  }

  if (!chave) { console.warn('[agenda] falta data-chave no <script>'); return; }
  fetch(origem + '/api/agenda/v1/eventos?limite=' + limite + '&chave=' + encodeURIComponent(chave))
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (j) { mostrar(j.eventos || []); })
    .catch(function (err) { console.warn('[agenda] não foi possível carregar os eventos:', err.message); alvo.innerHTML = ''; });
})();

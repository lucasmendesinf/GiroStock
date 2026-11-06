<?php
/*
 * Proximos eventos do GiroStock dentro do site (PHP). Feito para o site da J&A Conveniencia, mas serve para qualquer site:
 * troque a CHAVE e, se quiser, as classes do HTML.
 *
 * Como usar no site da J&A (index.php, secao #eventos):
 *   1. Copie este arquivo para a pasta do site (ex.: includes/proximos-eventos.php).
 *   2. Dentro de <div class="events__panel">, troque o bloco <div class="events__empty">...</div> por:
 *          <?php include __DIR__ . '/includes/proximos-eventos.php'; ?>
 *      O titulo "Proximos Eventos" continua o do site. Sem evento (ou se o GiroStock nao responder), aparece o "Em breve".
 *
 * Os eventos vem do GiroStock (Eventos > Agenda no site) e ficam guardados por 5 minutos numa pasta temporaria, para o site
 * nao depender do GiroStock a cada visita. So aparecem eventos marcados "Divulgar no site".
 */
if (!defined('GIROSTOCK_AGENDA_URL')) define('GIROSTOCK_AGENDA_URL', 'https://girostock.calutec.com.br/api/agenda/v1/eventos');
if (!defined('GIROSTOCK_AGENDA_CHAVE')) define('GIROSTOCK_AGENDA_CHAVE', 'COLE_AQUI_A_CHAVE');   // ag_... (GiroStock > Eventos > Agenda no site)
if (!defined('GIROSTOCK_AGENDA_LIMITE')) define('GIROSTOCK_AGENDA_LIMITE', 4);

if (!function_exists('girostock_eventos')) {
    function girostock_eventos() {
        $url = GIROSTOCK_AGENDA_URL . '?limite=' . (int) GIROSTOCK_AGENDA_LIMITE . '&chave=' . urlencode(GIROSTOCK_AGENDA_CHAVE);
        $cache = sys_get_temp_dir() . '/girostock-agenda-' . md5($url) . '.json';
        if (is_file($cache) && time() - filemtime($cache) < 300) {
            $dados = json_decode((string) file_get_contents($cache), true);
            if (is_array($dados)) return $dados;
        }
        $ctx = stream_context_create(['http' => ['timeout' => 4, 'ignore_errors' => true, 'header' => "Accept: application/json\r\n"]]);
        $resp = @file_get_contents($url, false, $ctx);
        $json = $resp ? json_decode($resp, true) : null;
        if (is_array($json) && isset($json['eventos']) && is_array($json['eventos'])) {
            @file_put_contents($cache, json_encode($json['eventos']));
            return $json['eventos'];
        }
        // GiroStock fora do ar: usa o ultimo resultado guardado, mesmo antigo.
        if (is_file($cache)) {
            $dados = json_decode((string) file_get_contents($cache), true);
            if (is_array($dados)) return $dados;
        }
        return [];
    }
}
if (!function_exists('ge')) {
    function ge($t) { return htmlspecialchars((string) $t, ENT_QUOTES, 'UTF-8'); }
}

$giroEventos = girostock_eventos();
?>
<?php if (!$giroEventos): ?>
<div class="events__empty">
    <span class="events__empty-icon"><svg class="icon icon--party" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 38 26 10l4 4-24 24Z"/><path d="M30 10l2 4 4 2-4 2-2 4-2-4-4-2 4-2Z"/><circle cx="14" cy="16" r="1.6" fill="currentColor" stroke="none"/><circle cx="34" cy="24" r="1.6" fill="currentColor" stroke="none"/></svg></span>
    <p>Em breve</p>
    <small>Acompanhe a J&A para novidades da programação.</small>
</div>
<?php else: ?>
<style>
    .events__list-item { align-items: flex-start; }
    .events__list-date { display: grid; place-items: center; min-width: 58px; padding: 8px 6px; border-radius: 12px; background: rgba(240, 180, 41, 0.14); line-height: 1; text-align: center; }
    .events__list-date b { display: block; font-size: 1.6rem; }
    .events__list-date small { display: block; margin-top: 4px; font-size: 0.75rem; text-transform: uppercase; }
    .events__list-info { display: grid; gap: 4px; flex: 1; min-width: 0; color: #fff; }
    .events__list-info h4 { margin: 0; font-size: 1.1rem; color: #fff; }
    .events__list-info p { margin: 0; color: rgba(255, 255, 255, 0.76); font-size: 0.92rem; }
    .events__list-when { color: var(--color-gold); font-weight: 800; font-size: 0.85rem; }
    .events__list-photo { width: 100%; max-height: 180px; object-fit: cover; border-radius: 10px; margin-bottom: 6px; }
    .events__list-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; align-items: center; }
    .events__list-actions a { padding: 7px 14px; border-radius: 999px; font-size: 0.85rem; font-weight: 800; text-decoration: none; }
    .events__list-ticket { background: var(--color-gold); color: var(--color-ink); }
    .events__list-share { border: 1px solid rgba(255, 255, 255, 0.3); color: #fff; }
    .events__list-now { display: inline-block; margin-left: 6px; padding: 2px 8px; border-radius: 999px; background: var(--color-green); color: #fff; font-size: 0.7rem; vertical-align: middle; }
</style>
<div class="events__list">
    <?php foreach ($giroEventos as $ev):
        $diaSemana = mb_strtoupper(mb_substr($ev['dia_semana'], 0, 1, 'UTF-8'), 'UTF-8') . mb_substr($ev['dia_semana'], 1, null, 'UTF-8');
        $quando = $diaSemana . ', ' . substr($ev['data'], 0, 5) . ' · ' . $ev['hora'] . ($ev['hora_fim'] ? ' às ' . $ev['hora_fim'] : '');
        $compartilhar = $ev['nome'] . ' — ' . $ev['dia_semana'] . ', ' . substr($ev['data'], 0, 5) . ' às ' . $ev['hora'] . "\nhttps://jaconveniencia.com.br/#eventos";
    ?>
    <article class="events__list-item">
        <span class="events__list-date"><b><?= ge($ev['dia']) ?></b><small><?= ge($ev['mes']) ?></small></span>
        <div class="events__list-info">
            <?php if (!empty($ev['imagem'])): ?><img class="events__list-photo" src="<?= ge($ev['imagem']) ?>" alt="<?= ge($ev['nome']) ?>" loading="lazy"><?php endif; ?>
            <span class="events__list-when"><?= ge($quando) ?><?php if (!empty($ev['em_andamento'])): ?><span class="events__list-now">acontecendo agora</span><?php endif; ?></span>
            <h4><?= ge($ev['nome']) ?></h4>
            <?php if (!empty($ev['atracoes'])): ?><p><?= ge($ev['atracoes']) ?></p><?php endif; ?>
            <?php if (!empty($ev['descricao'])): ?><p><?= nl2br(ge($ev['descricao'])) ?></p><?php endif; ?>
            <div class="events__list-actions">
                <?php if ($ev['preco_ingresso'] !== null): ?><p><?= $ev['preco_ingresso'] > 0 ? 'Ingresso R$ ' . number_format($ev['preco_ingresso'], 2, ',', '.') : 'Entrada gratuita' ?></p><?php endif; ?>
                <?php if (!empty($ev['link_ingresso'])): ?><a class="events__list-ticket" href="<?= ge($ev['link_ingresso']) ?>" target="_blank" rel="noopener noreferrer">Comprar ingresso</a><?php endif; ?>
                <a class="events__list-share" href="https://wa.me/?text=<?= rawurlencode($compartilhar) ?>" target="_blank" rel="noopener noreferrer">Compartilhar</a>
            </div>
        </div>
    </article>
    <?php endforeach; ?>
</div>
<?php endif; ?>

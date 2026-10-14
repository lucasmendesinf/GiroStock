// Logomarca do GiroStock (aprovada em docs/logo/): duas setas em giro (dourada e vinho) ao redor de uma caixa.
// O SVG e inline e usa variaveis CSS (--logo-*, definidas por tema em styles.css): a marca troca de cor com o tema sem recarregar.
export function Marca({ tamanho = 40, decorativa = true }) {
  return (
    <svg className="marca-svg" viewBox="0 0 64 64" width={tamanho} height={tamanho} aria-hidden={decorativa ? 'true' : undefined} role={decorativa ? undefined : 'img'} aria-label={decorativa ? undefined : 'GiroStock'} focusable="false">
      <path d="M5.92 25.01A27 27 0 0 1 58.08 25.01" fill="none" stroke="var(--logo-seta-1)" strokeWidth="4" strokeLinecap="round" />
      <polygon points="60.15,32.74 63.35,21.53 51.76,24.63" fill="var(--logo-seta-1)" />
      <path d="M58.08 38.99A27 27 0 0 1 5.92 38.99" fill="none" stroke="var(--logo-seta-2)" strokeWidth="4" strokeLinecap="round" />
      <polygon points="3.85,31.26 0.65,42.47 12.24,39.37" fill="var(--logo-seta-2)" />
      <g transform="translate(16 16) scale(.5)">
        <polygon points="32,5 55,18.5 32,32 9,18.5" fill="var(--logo-caixa-topo)" />
        <polygon points="9,18.5 32,32 32,59 9,45.5" fill="var(--logo-caixa-esq)" />
        <polygon points="55,18.5 32,32 32,59 55,45.5" fill="var(--logo-caixa-dir)" />
      </g>
    </svg>
  );
}

// Marca + nome como TEXTO (acessivel e acompanha o tema). `legenda` mostra "PDV · ESTOQUE"; `vertical` empilha (tela de login).
export function Logo({ tamanho = 36, legenda = false, vertical = false }) {
  return (
    <span className={`logo${vertical ? ' logo-vertical' : ''}`}>
      <Marca tamanho={tamanho} />
      <span className="logo-textos">
        <span className="logo-nome"><span className="logo-giro">Giro</span><span className="logo-stock">Stock</span></span>
        {legenda && <span className="logo-legenda">PDV · ESTOQUE</span>}
      </span>
    </span>
  );
}

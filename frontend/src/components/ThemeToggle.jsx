import { useTheme } from '../context/ThemeContext.jsx';

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isLight = theme === 'light';

  return (
    <button
      type="button"
      className="theme-toggle"
      role="switch"
      aria-checked={isLight}
      aria-label={isLight ? 'Mudar para tema escuro' : 'Mudar para tema claro'}
      onClick={toggleTheme}
    >
      <span className="theme-toggle-thumb">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0 L14.5 9.5 L24 12 L14.5 14.5 L12 24 L9.5 14.5 L0 12 L9.5 9.5 Z" />
        </svg>
      </span>
    </button>
  );
}

import { forwardRef } from 'react';
import { parseNumero } from '../utils/format';

function formatar(n, casas) {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

// Campo de dinheiro no padrao brasileiro: digita-se so os numeros e a mascara
// preenche os centavos (1 2 5 0 -> 12,50; 1 2 3 4 5 6 -> 1.234,56).
// O valor sai como texto "1.234,56", que parseNumero() entende.
// `casas`: 2 para valores em R$; 4 para custo por unidade (ex: R$ 0,0350 por grama).
const MoneyInput = forwardRef(function MoneyInput({ value, onChange, casas = 2, maxDigitos = 12, onFocus, ...rest }, ref) {
  const n = parseNumero(value);
  const vazio = value === '' || value === null || value === undefined || !Number.isFinite(n);
  const exibido = vazio ? '' : formatar(n, casas);

  function alterar(e) {
    const digitos = e.target.value.replace(/\D/g, '').slice(0, maxDigitos);
    onChange(digitos === '' ? '' : formatar(Number(digitos) / 10 ** casas, casas));
  }

  return (
    <input
      {...rest}
      ref={ref}
      inputMode="numeric"
      autoComplete="off"
      value={exibido}
      onChange={alterar}
      onFocus={(e) => { if (onFocus) onFocus(e); const el = e.target; setTimeout(() => el.select(), 0); }}
    />
  );
});

export default MoneyInput;

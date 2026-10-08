import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { fmtTel } from '../utils/format';

const diasTxt = (d) => (d === null || d === undefined ? '' : d === 0 ? 'hoje' : `há ${d} dia${d === 1 ? '' : 's'}`);

// Campo de telefone do cliente: 10+ digitos localiza o cadastro (cartao verde); 4-9 digitos sugere ate 3 clientes.
// O pai guarda o telefone (so texto) e recebe o cliente localizado em onCliente (null quando nao ha cadastro).
export default function ClienteTelefone({ telefone, onTelefone, cliente, onCliente, autoFocus = false, solto = false, rotulo = 'Cliente (opcional) — digite o telefone', dica = '', textoNovo = 'Telefone não cadastrado: será criado ao gerar o pedido, com o nome e o endereço informados.' }) {
  const [sugestoes, setSugestoes] = useState([]);
  const [consultado, setConsultado] = useState(false);
  const timer = useRef(null);
  const digitos = telefone.replace(/\D/g, '');

  useEffect(() => {
    clearTimeout(timer.current);
    setConsultado(false);
    if (digitos.length >= 10) {
      timer.current = setTimeout(async () => {
        try {
          const c = await api.get(`/customers/by-phone/${digitos}`);
          onCliente(c || null);
          setSugestoes([]);
        } catch { onCliente(null); } finally { setConsultado(true); }
      }, 250);
    } else if (digitos.length >= 4) {
      onCliente(null);
      timer.current = setTimeout(async () => {
        try { setSugestoes(await api.get(`/customers/suggest?telefone=${digitos}`)); } catch { setSugestoes([]); }
      }, 250);
    } else { onCliente(null); setSugestoes([]); }
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digitos]);

  return (
    <div className={`cli-tel ${solto ? 'solto' : ''}`}>
      <label className="field">
        <span className="field-label">{rotulo}</span>
        <input value={telefone} onChange={(e) => onTelefone(fmtTel(e.target.value))} placeholder="(00) 00000-0000" inputMode="tel" autoFocus={autoFocus} />
      </label>
      {sugestoes.length > 0 && (
        <div className="cli-sug">
          {sugestoes.map((s) => <button type="button" key={s.id} onClick={() => onTelefone(fmtTel(s.telefone))}><b>{s.nome}</b> <small>{fmtTel(s.telefone)}</small></button>)}
        </div>
      )}
      {cliente && (
        <div className="cli-card ok">
          <b>✔ Cliente cadastrado</b>
          <div><b>{cliente.nome}</b> · {fmtTel(cliente.telefone)}</div>
          {cliente.enderecos.length > 0 && <small>🏠 {cliente.enderecos.map((e) => e.endereco).join(' · ')}</small>}
          <small>{cliente.pedidos} pedido{cliente.pedidos === 1 ? '' : 's'}{cliente.pedidos > 0 ? ` · último ${diasTxt(cliente.dias_ultimo)}` : ''}</small>
          {dica && <small className="cli-dica">{dica}</small>}
        </div>
      )}
      {!cliente && consultado && digitos.length >= 10 && (
        <div className="cli-card novo"><b>Cliente novo.</b> {textoNovo}</div>
      )}
    </div>
  );
}

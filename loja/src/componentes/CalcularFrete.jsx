import { useState } from 'react';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import { brl, soDigitos } from '../util';

const lerCep = () => { try { return localStorage.getItem('lv_cep') || ''; } catch { return ''; } };
const gravarCep = (c) => { try { localStorage.setItem('lv_cep', c); } catch { /* sem armazenamento */ } };

// Calcular frete pelo CEP antes do checkout (produto e carrinho). itens: como na API do carrinho.
export default function CalcularFrete({ itens }) {
  const { loja } = useLoja();
  const [cep, setCep] = useState(lerCep);
  const [r, setR] = useState(null);
  const [carregando, setCarregando] = useState(false);
  if (!loja.entrega.transportadora || !itens || itens.length === 0) return null;
  async function calcular(e) {
    e.preventDefault();
    const c = soDigitos(cep);
    if (c.length !== 8) { setR({ erro: 'Digite o CEP com 8 números' }); return; }
    setCarregando(true);
    try { setR(await api.post('/frete', { cep: c, itens })); gravarCep(c); } catch (err) { setR({ erro: err.message }); } finally { setCarregando(false); }
  }
  const mascara = (v) => { const d = soDigitos(v).slice(0, 8); return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d; };
  return (
    <div className="painel">
      <h2>Calcular frete</h2>
      <form className="calcular-frete" onSubmit={calcular}>
        <input inputMode="numeric" autoComplete="postal-code" value={mascara(cep)} onChange={(e) => setCep(e.target.value)} placeholder="00000-000" aria-label="CEP" />
        <button type="submit" className="botao botao-claro" disabled={carregando}>{carregando ? '…' : 'Calcular'}</button>
      </form>
      {r && r.erro && <p className="erro-texto">{r.erro}</p>}
      {r && r.opcoes && (r.opcoes.length === 0 ? <p className="dica">{r.avisos[0] || 'Nenhuma transportadora atende este CEP.'}</p> : (
        <ul className="lista-frete">
          {r.opcoes.map((o) => (
            <li key={o.id}><span>{o.nome}<small>{o.prazo_dias ? `até ${o.prazo_dias} dias úteis` : ''}</small></span><b className={o.gratis ? 'ok-texto' : ''}>{o.gratis ? 'Grátis' : brl(o.preco)}</b></li>
          ))}
        </ul>
      ))}
      {loja.entrega.transportadora.cidade_entrega_local && <p className="dica">Em {loja.entrega.transportadora.cidade_entrega_local}, a loja também entrega (escolha no fechamento do pedido).</p>}
    </div>
  );
}

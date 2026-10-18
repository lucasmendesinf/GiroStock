import { useState } from 'react';
import { api } from '../api';
import { soDigitos } from '../util';

// Formulario de endereco. O CEP preenche rua/bairro/cidade (ViaCEP, consulta publica); se falhar, digita a mao.
export default function FormEndereco({ inicial, onSalvo, onCancelar }) {
  const [f, setF] = useState({
    rotulo: 'Casa', cep: '', logradouro: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '', referencia: '', ...(inicial || {}),
  });
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function buscarCep(valor) {
    const cep = soDigitos(valor);
    if (cep.length !== 8) return;
    setBuscando(true);
    try {
      const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`).then((x) => x.json());
      if (r && !r.erro) setF((x) => ({ ...x, cep, logradouro: r.logradouro || x.logradouro, bairro: r.bairro || x.bairro, cidade: r.localidade || x.cidade, uf: r.uf || x.uf }));
    } catch { /* sem internet ou ViaCEP fora: preenche a mao */ } finally { setBuscando(false); }
  }
  async function salvar(e) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      const corpo = { ...f, cep: soDigitos(f.cep) };
      const r = inicial && inicial.id ? await api.put(`/conta/enderecos/${inicial.id}`, corpo) : await api.post('/conta/enderecos', corpo);
      onSalvo(r);
    } catch (err) { setErro(err.message); } finally { setEnviando(false); }
  }
  return (
    <form className="formulario endereco-form" onSubmit={salvar}>
      <div className="linha-2">
        <label className="campo"><span>CEP</span><input value={f.cep} onChange={(e) => { mudar('cep')(e); buscarCep(e.target.value); }} inputMode="numeric" autoComplete="postal-code" placeholder="00000-000" />{buscando && <small>Buscando…</small>}</label>
        <label className="campo"><span>Nome do endereço</span><input value={f.rotulo} onChange={mudar('rotulo')} maxLength={30} placeholder="Casa, Trabalho…" /></label>
      </div>
      <label className="campo"><span>Rua</span><input value={f.logradouro} onChange={mudar('logradouro')} autoComplete="address-line1" required /></label>
      <div className="linha-2">
        <label className="campo"><span>Número</span><input value={f.numero} onChange={mudar('numero')} required placeholder="ou s/n" /></label>
        <label className="campo"><span>Complemento</span><input value={f.complemento} onChange={mudar('complemento')} autoComplete="address-line2" placeholder="Apto, bloco…" /></label>
      </div>
      <label className="campo"><span>Bairro</span><input value={f.bairro} onChange={mudar('bairro')} required /></label>
      <div className="linha-2">
        <label className="campo"><span>Cidade</span><input value={f.cidade} onChange={mudar('cidade')} autoComplete="address-level2" /></label>
        <label className="campo"><span>UF</span><input value={f.uf} onChange={(e) => setF({ ...f, uf: e.target.value.toUpperCase().slice(0, 2) })} autoComplete="address-level1" /></label>
      </div>
      <label className="campo"><span>Ponto de referência</span><input value={f.referencia} onChange={mudar('referencia')} maxLength={150} /></label>
      {erro && <p className="erro-texto">{erro}</p>}
      <div className="botoes">
        {onCancelar && <button type="button" className="botao botao-claro" onClick={onCancelar}>Cancelar</button>}
        <button type="submit" className="botao" disabled={enviando}>{enviando ? 'Salvando…' : 'Salvar endereço'}</button>
      </div>
    </form>
  );
}

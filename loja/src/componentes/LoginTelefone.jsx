import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import { mascaraTel, soDigitos } from '../util';

// Login por telefone + codigo de 6 numeros (sem senha). Etapas: telefone -> codigo -> (cliente novo) nome.
// aoEntrar(resultado) e chamado depois de entrar, para quem abriu retomar o que o cliente estava fazendo.
export default function LoginTelefone({ aoEntrar }) {
  const { entrar, avisar } = useLoja();
  const [etapa, setEtapa] = useState('telefone');
  const [tel, setTel] = useState('');
  const [codigo, setCodigo] = useState('');
  const [nome, setNome] = useState('');
  const [aceita, setAceita] = useState(false);
  const [espera, setEspera] = useState(0);
  const [teste, setTeste] = useState(null);
  const [tamanhoCodigo, setTamanhoCodigo] = useState(6);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState(null);
  const campoCodigo = useRef(null);

  useEffect(() => {
    if (espera <= 0) return undefined;
    const t = setTimeout(() => setEspera((e) => e - 1), 1000);
    return () => clearTimeout(t);
  }, [espera]);

  async function pedirCodigo(e) {
    if (e) e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      const r = await api.post('/conta/codigo', { telefone: soDigitos(tel) });
      setTeste(r.codigo_teste || null);
      setTamanhoCodigo(r.codigo_teste ? r.codigo_teste.length : 6);
      setEspera(r.reenviar_em_s || 30);
      setCodigo('');
      setEtapa('codigo');
      setTimeout(() => campoCodigo.current && campoCodigo.current.focus(), 60);
    } catch (err) {
      setErro(err.message);
    } finally {
      setEnviando(false);
    }
  }

  async function confirmar(cod, nomeInformado) {
    setErro(null);
    setEnviando(true);
    try {
      const r = await api.post('/conta/entrar', { telefone: soDigitos(tel), codigo: cod, nome: nomeInformado || undefined, aceita_mensagens: nomeInformado ? aceita : undefined });
      if (r.precisa_nome) { setEtapa('nome'); return; }
      entrar(r);
      if (r.nova) avisar('Conta criada!');
      aoEntrar(r);
    } catch (err) {
      setErro(err.message);
      setCodigo('');
      if (campoCodigo.current) campoCodigo.current.focus();
    } finally {
      setEnviando(false);
    }
  }

  function mudarCodigo(v) {
    const c = soDigitos(v).slice(0, tamanhoCodigo);
    setCodigo(c);
    if (c.length === tamanhoCodigo && !enviando) confirmar(c);
  }

  if (etapa === 'telefone') {
    return (
      <form className="cd-login" onSubmit={pedirCodigo}>
        <p className="cd-login-dica">Informe seu celular. Enviamos um código de 6 números por WhatsApp ou SMS, sem senha.</p>
        <label className="campo"><span>Celular com DDD</span>
          <input data-foco value={tel} onChange={(e) => setTel(mascaraTel(e.target.value))} inputMode="tel" autoComplete="tel" placeholder="(11) 99999-0000" required />
        </label>
        {erro && <p className="erro-texto" role="alert">{erro}</p>}
        <button type="submit" className="botao largo" disabled={enviando || soDigitos(tel).length < 10}>{enviando ? 'Enviando…' : 'Enviar código'}</button>
      </form>
    );
  }

  if (etapa === 'nome') {
    return (
      <form className="cd-login" onSubmit={(e) => { e.preventDefault(); confirmar(codigo, nome.trim()); }}>
        <p className="cd-login-dica">Primeira vez por aqui! Diga como podemos chamar você.</p>
        <label className="campo"><span>Seu nome</span>
          <input data-foco value={nome} onChange={(e) => setNome(e.target.value)} autoComplete="name" minLength={3} required placeholder="Nome e sobrenome" />
        </label>
        <label className="marcar"><input type="checkbox" checked={aceita} onChange={(e) => setAceita(e.target.checked)} /> Quero receber promoções pelo WhatsApp</label>
        {erro && <p className="erro-texto" role="alert">{erro}</p>}
        <button type="submit" className="botao largo" disabled={enviando || nome.trim().length < 3}>{enviando ? 'Entrando…' : 'Criar conta e entrar'}</button>
      </form>
    );
  }

  return (
    <div className="cd-login">
      <p className="cd-login-dica">{teste ? 'Digite o código de teste' : 'Digite o código enviado'} para <b>{tel}</b>.</p>
      <label className="campo"><span>Código de {tamanhoCodigo} números</span>
        <input ref={campoCodigo} data-foco className="cd-codigo" value={codigo} onChange={(e) => mudarCodigo(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={tamanhoCodigo} placeholder={'0'.repeat(tamanhoCodigo)} aria-label={`Código de ${tamanhoCodigo} números`} />
      </label>
      {teste && <p className="dica">Ambiente de teste: use o código {teste}</p>}
      {erro && <p className="erro-texto" role="alert">{erro}</p>}
      <div className="cd-login-acoes">
        <button type="button" className="link" onClick={() => pedirCodigo()} disabled={espera > 0 || enviando}>{espera > 0 ? `Reenviar em ${espera}s` : 'Reenviar código'}</button>
        <button type="button" className="link" onClick={() => { setEtapa('telefone'); setErro(null); }}>Trocar telefone</button>
      </div>
    </div>
  );
}

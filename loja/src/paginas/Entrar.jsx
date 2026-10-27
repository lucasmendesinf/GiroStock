import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useLoja } from '../estado.jsx';

// Entrar, criar conta e recuperar a senha (codigo por e-mail).
export default function Entrar({ modo }) {
  const { entrar, avisar } = useLoja();
  const navegar = useNavigate();
  const [params] = useSearchParams();
  const depois = params.get('depois') || '/';
  const [f, setF] = useState({ nome: '', email: '', telefone: '', cpf: '', senha: '', codigo: '', aceita_mensagens: false });
  const [etapa, setEtapa] = useState(1); // recuperar: 1 = pedir codigo, 2 = codigo + nova senha
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState(null);
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const qs = depois !== '/' ? `?depois=${encodeURIComponent(depois)}` : '';

  async function enviar(e) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      if (modo === 'entrar') {
        entrar(await api.post('/conta/login', { email: f.email, senha: f.senha }));
        navegar(depois, { replace: true });
      } else if (modo === 'cadastro') {
        entrar(await api.post('/conta/cadastro', { nome: f.nome, email: f.email, telefone: f.telefone, cpf: f.cpf || undefined, senha: f.senha, aceita_mensagens: f.aceita_mensagens }));
        avisar('Conta criada!');
        navegar(depois, { replace: true });
      } else if (etapa === 1) {
        await api.post('/conta/esqueci-senha', { email: f.email });
        setEtapa(2);
      } else {
        entrar(await api.post('/conta/redefinir-senha', { email: f.email, codigo: f.codigo, senha: f.senha }));
        avisar('Senha alterada!');
        navegar(depois, { replace: true });
      }
    } catch (err) {
      setErro(err.message);
    } finally {
      setEnviando(false);
    }
  }

  const titulo = { entrar: 'Entrar', cadastro: 'Criar conta', recuperar: 'Recuperar senha' }[modo];
  return (
    <section className="bloco caixa-estreita">
      <h1>{titulo}</h1>
      <form className="formulario" onSubmit={enviar}>
        {modo === 'cadastro' && (
          <>
            <label className="campo"><span>Nome completo</span><input value={f.nome} onChange={mudar('nome')} autoComplete="name" required minLength={3} /></label>
            <label className="campo"><span>Celular (WhatsApp)</span><input value={f.telefone} onChange={mudar('telefone')} inputMode="tel" autoComplete="tel" placeholder="(11) 99999-0000" required /></label>
          </>
        )}
        {(modo !== 'recuperar' || etapa === 1) && <label className="campo"><span>E-mail</span><input type="email" value={f.email} onChange={mudar('email')} autoComplete="email" required /></label>}
        {modo === 'recuperar' && etapa === 2 && (
          <>
            <p className="dica">Se houver uma conta com <b>{f.email}</b>, enviamos um código de 6 números. Ele vale por 15 minutos.</p>
            <label className="campo"><span>Código</span><input value={f.codigo} onChange={mudar('codigo')} inputMode="numeric" autoComplete="one-time-code" maxLength={6} required /></label>
          </>
        )}
        {(modo !== 'recuperar' || etapa === 2) && (
          <label className="campo">
            <span>{modo === 'recuperar' ? 'Nova senha' : 'Senha'}</span>
            <input type="password" value={f.senha} onChange={mudar('senha')} autoComplete={modo === 'entrar' ? 'current-password' : 'new-password'} required minLength={modo === 'entrar' ? 1 : 8} />
            {modo !== 'entrar' && <small>Pelo menos 8 caracteres, com letras e números.</small>}
          </label>
        )}
        {modo === 'cadastro' && (
          <>
            <label className="campo"><span>CPF (opcional)</span><input value={f.cpf} onChange={mudar('cpf')} inputMode="numeric" placeholder="Ajuda no pagamento por Pix/cartão" /></label>
            <label className="marcar"><input type="checkbox" checked={f.aceita_mensagens} onChange={mudar('aceita_mensagens')} /> Quero receber promoções pelo WhatsApp</label>
          </>
        )}
        {erro && <p className="erro-texto">{erro}</p>}
        <button type="submit" className="botao largo" disabled={enviando}>
          {enviando ? 'Aguarde…' : modo === 'entrar' ? 'Entrar' : modo === 'cadastro' ? 'Criar conta' : etapa === 1 ? 'Enviar código' : 'Salvar nova senha'}
        </button>
      </form>
      <div className="links-conta">
        {modo === 'entrar' && <><Link to={`/cadastro${qs}`}>Ainda não tenho conta</Link><Link to={`/recuperar-senha${qs}`}>Esqueci a senha</Link></>}
        {modo === 'cadastro' && <Link to={`/entrar${qs}`}>Já tenho conta</Link>}
        {modo === 'recuperar' && <Link to={`/entrar${qs}`}>Voltar para entrar</Link>}
      </div>
    </section>
  );
}

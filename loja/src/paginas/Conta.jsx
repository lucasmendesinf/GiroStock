import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import FormEndereco from '../componentes/Endereco.jsx';

// Minha conta: dados, enderecos, senha, sair e excluir a conta.
export default function Conta() {
  const { conta, sair, atualizarConta, avisar } = useLoja();
  const navegar = useNavigate();
  const [f, setF] = useState(null);
  const [enderecos, setEnderecos] = useState([]);
  const [editando, setEditando] = useState(null); // endereco ou {} = novo
  const [senha, setSenha] = useState({ atual: '', nova: '' });
  useEffect(() => {
    if (!conta) return;
    setF({ nome: conta.nome, telefone: conta.telefone, cpf: conta.cpf || '', aceita_mensagens: conta.aceita_mensagens });
    api.get('/conta/enderecos').then(setEnderecos).catch(() => {});
  }, [conta]);
  if (!conta) return <Navigate to="/entrar?depois=/conta" replace />;
  if (!f) return <div className="carregando" />;

  async function salvarDados(e) {
    e.preventDefault();
    try { atualizarConta(await api.put('/conta', { ...f, cpf: f.cpf || null })); avisar('Dados salvos'); } catch (err) { avisar(err.message, 'erro'); }
  }
  async function trocarSenha(e) {
    e.preventDefault();
    try { const r = await api.put('/conta/senha', { senha_atual: senha.atual, nova_senha: senha.nova }); atualizarConta(null, r.token); setSenha({ atual: '', nova: '' }); avisar('Senha alterada'); } catch (err) { avisar(err.message, 'erro'); }
  }
  async function removerEndereco(e) {
    if (!window.confirm(`Remover o endereço "${e.rotulo}"?`)) return;
    try { await api.del(`/conta/enderecos/${e.id}`); setEnderecos(await api.get('/conta/enderecos')); } catch (err) { avisar(err.message, 'erro'); }
  }
  async function tornarPadrao(e) {
    try { await api.put(`/conta/enderecos/${e.id}`, { padrao: true }); setEnderecos(await api.get('/conta/enderecos')); } catch (err) { avisar(err.message, 'erro'); }
  }
  async function excluir() {
    const s = window.prompt('Para excluir sua conta, digite sua senha. Seus dados pessoais e endereços serão apagados.');
    if (!s) return;
    try { await api.del('/conta', { senha: s }); sair(); avisar('Conta excluída'); navegar('/'); } catch (err) { avisar(err.message, 'erro'); }
  }
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <section className="bloco caixa-media">
      <div className="bloco-topo"><h1>Minha conta</h1><button type="button" className="link" onClick={() => { sair(); navegar('/'); }}>Sair</button></div>
      <Link to="/pedidos" className="botao botao-claro largo">Meus pedidos</Link>

      <form className="painel formulario" onSubmit={salvarDados}>
        <h2>Meus dados</h2>
        <p className="dica">{conta.email}</p>
        <label className="campo"><span>Nome</span><input value={f.nome} onChange={mudar('nome')} required minLength={3} /></label>
        <div className="linha-2">
          <label className="campo"><span>Celular</span><input value={f.telefone} onChange={mudar('telefone')} inputMode="tel" required /></label>
          <label className="campo"><span>CPF</span><input value={f.cpf} onChange={mudar('cpf')} inputMode="numeric" /></label>
        </div>
        <label className="marcar"><input type="checkbox" checked={f.aceita_mensagens} onChange={mudar('aceita_mensagens')} /> Quero receber promoções pelo WhatsApp</label>
        <button type="submit" className="botao">Salvar dados</button>
      </form>

      <div className="painel">
        <h2>Endereços</h2>
        {enderecos.map((e) => (
          <div key={e.id} className="endereco-linha">
            <span><b>{e.rotulo}</b>{e.padrao && <span className="etiqueta">padrão</span>}<br />{e.logradouro}, {e.numero}{e.complemento ? ` - ${e.complemento}` : ''} – {e.bairro}{e.cidade ? `, ${e.cidade}` : ''}</span>
            <span className="acoes">
              <button type="button" className="link" onClick={() => setEditando(e)}>Editar</button>
              {!e.padrao && <button type="button" className="link" onClick={() => tornarPadrao(e)}>Tornar padrão</button>}
              <button type="button" className="link perigo" onClick={() => removerEndereco(e)}>Remover</button>
            </span>
          </div>
        ))}
        {editando ? (
          <FormEndereco inicial={editando.id ? editando : null} onSalvo={async () => { setEditando(null); setEnderecos(await api.get('/conta/enderecos')); }} onCancelar={() => setEditando(null)} />
        ) : <button type="button" className="link" onClick={() => setEditando({})}>+ Novo endereço</button>}
      </div>

      <form className="painel formulario" onSubmit={trocarSenha}>
        <h2>Trocar senha</h2>
        <label className="campo"><span>Senha atual</span><input type="password" value={senha.atual} onChange={(e) => setSenha({ ...senha, atual: e.target.value })} autoComplete="current-password" required /></label>
        <label className="campo"><span>Nova senha</span><input type="password" value={senha.nova} onChange={(e) => setSenha({ ...senha, nova: e.target.value })} autoComplete="new-password" required minLength={8} /><small>Pelo menos 8 caracteres, com letras e números.</small></label>
        <button type="submit" className="botao botao-claro">Trocar senha</button>
      </form>
      <button type="button" className="link perigo centro" onClick={excluir}>Excluir minha conta</button>
    </section>
  );
}

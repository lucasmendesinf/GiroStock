import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/UiContext.jsx';
import { Field, Modal } from './ui.jsx';

// Campo de 6 digitos do app autenticador: so numeros, teclado numerico, envia sozinho ao completar.
export function CampoCodigo({ valor, onChange, onCompleto, autoFocus = true, disabled }) {
  const ref = useRef(null);
  useEffect(() => { if (autoFocus && !disabled && ref.current) ref.current.focus(); }, [autoFocus, disabled]);
  return (
    <input
      ref={ref}
      className="campo-codigo"
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      placeholder="000000"
      aria-label="Código de 6 dígitos"
      value={valor}
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value.replace(/\D/g, '').slice(0, 6);
        onChange(v);
        if (v.length === 6 && onCompleto) onCompleto(v);
      }}
    />
  );
}

function baixarCodigos(codigos) {
  const texto = `GiroStock - códigos de recuperação (use cada um uma única vez)\r\n\r\n${codigos.join('\r\n')}\r\n`;
  const url = URL.createObjectURL(new Blob([texto], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'girostock-codigos-recuperacao.txt'; a.click();
  URL.revokeObjectURL(url);
}

function imprimirCodigos(codigos) {
  const w = window.open('', '_blank', 'width=420,height=520');
  if (!w) return;
  w.document.write(`<pre style="font:18px monospace">GiroStock - códigos de recuperação\n(cada um vale uma única vez)\n\n${codigos.join('\n')}</pre>`);
  w.document.close(); w.focus(); w.print();
}

// Lista dos 10 codigos com copiar / baixar / imprimir; so segue depois de marcar "Guardei meus códigos".
export function CodigosDeRecuperacao({ codigos, rotuloBotao = 'Concluir', onConcluir }) {
  const toast = useToast();
  const [guardei, setGuardei] = useState(false);
  async function copiar() {
    try { await navigator.clipboard.writeText(codigos.join('\n')); toast.sucesso('Códigos copiados.'); } catch { toast.erro('Não foi possível copiar. Use "Baixar".'); }
  }
  return (
    <div className="form-stack">
      <p>Guarde estes códigos em um lugar seguro. Cada um vale <strong>uma única vez</strong> e é a sua saída se perder o celular. Eles não serão mostrados de novo.</p>
      <ul className="codigos-rec">{codigos.map((c) => <li key={c}>{c}</li>)}</ul>
      <div className="row-actions">
        <button type="button" className="btn-link" onClick={copiar}>Copiar</button>
        <button type="button" className="btn-link" onClick={() => baixarCodigos(codigos)}>Baixar</button>
        <button type="button" className="btn-link" onClick={() => imprimirCodigos(codigos)}>Imprimir</button>
      </div>
      <label className="check-linha"><input type="checkbox" checked={guardei} onChange={(e) => setGuardei(e.target.checked)} /> Guardei meus códigos</label>
      <button type="button" className="btn-primario" disabled={!guardei} onClick={onConcluir}>{rotuloBotao}</button>
    </div>
  );
}

// Fluxo de ativacao: QR + chave -> codigo do app -> codigos de recuperacao.
// tokenMfa: token do fluxo "configurar" (login forcado); sem ele usa a sessao normal.
// onConcluido(resposta): ao fim (no fluxo forcado a resposta traz token/usuario).
export function AtivarDoisFatores({ tokenMfa, onConcluido, onCancelar }) {
  const [prep, setPrep] = useState(null);
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const opcoes = tokenMfa ? { token: tokenMfa } : undefined;

  useEffect(() => {
    let ativo = true;
    api.post('/auth/2fa/preparar', undefined, opcoes)
      .then((d) => { if (ativo) setPrep(d); })
      .catch((e) => { if (ativo) setErro(e.message); });
    return () => { ativo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ativar(c) {
    if (enviando) return;
    setErro(null); setEnviando(true);
    try {
      setResultado(await api.post('/auth/2fa/ativar', { codigo: c }, opcoes));
    } catch (e) { setErro(e.message); setCodigo(''); } finally { setEnviando(false); }
  }

  if (resultado) {
    return <CodigosDeRecuperacao codigos={resultado.codigos_recuperacao} onConcluir={() => onConcluido(resultado)} />;
  }
  return (
    <div className="form-stack">
      <ol className="passos-2fa">
        <li>Instale um app autenticador no celular (Google Authenticator, Microsoft Authenticator ou similar).</li>
        <li>Escaneie o QR code abaixo ou digite a chave manualmente.</li>
        <li>Digite o código de 6 dígitos que o app mostrar.</li>
      </ol>
      {prep ? (
        <div className="qr-2fa">
          <img src={prep.qr} alt="QR code para o app autenticador" width="200" height="200" />
          <div className="chave-2fa"><span>Chave manual</span><code>{prep.chave}</code></div>
        </div>
      ) : !erro && <p className="muted">Gerando QR code…</p>}
      {prep && (
        <Field label="Código do app">
          <CampoCodigo valor={codigo} onChange={setCodigo} onCompleto={ativar} autoFocus={false} disabled={enviando} />
        </Field>
      )}
      {erro && <p className="error" role="alert">{erro}</p>}
      <div className="modal-actions">
        {onCancelar && <button type="button" onClick={onCancelar}>Cancelar</button>}
        <button type="button" disabled={!prep || codigo.length !== 6 || enviando} onClick={() => ativar(codigo)}>{enviando ? 'Verificando…' : 'Ativar'}</button>
      </div>
    </div>
  );
}

// Menu da conta -> "Verificação em duas etapas".
export default function SegurancaModal({ onClose }) {
  const { user, recarregarUsuario } = useAuth();
  const toast = useToast();
  const df = user?.doisFatores || { ativo: false, exigido: false, codigosRestantes: 0 };
  const obrigatorio = !!user?.master || df.exigido;
  const [modo, setModo] = useState('inicio'); // inicio | ativar | desativar | codigos | mostrar
  const [form, setForm] = useState({ senha: '', codigo: '' });
  const [erro, setErro] = useState(null);
  const [novosCodigos, setNovosCodigos] = useState(null);

  function abrir(m) { setForm({ senha: '', codigo: '' }); setErro(null); setModo(m); }

  async function enviar(e, rota, aoOk) {
    e.preventDefault();
    setErro(null);
    try { aoOk(await api.post(rota, form)); } catch (err) { setErro(err.message); setForm({ ...form, codigo: '' }); }
  }

  const campos = (
    <>
      <Field label="Sua senha"><input type="password" autoComplete="current-password" value={form.senha} onChange={(e) => setForm({ ...form, senha: e.target.value })} required autoFocus /></Field>
      <Field label="Código do app"><CampoCodigo valor={form.codigo} onChange={(v) => setForm({ ...form, codigo: v })} autoFocus={false} /></Field>
      {erro && <p className="error" role="alert">{erro}</p>}
    </>
  );

  let corpo;
  if (modo === 'ativar') {
    corpo = <AtivarDoisFatores onCancelar={() => setModo('inicio')} onConcluido={async () => { await recarregarUsuario(); toast.sucesso('Verificação em duas etapas ativada.'); onClose(); }} />;
  } else if (modo === 'mostrar') {
    corpo = <CodigosDeRecuperacao codigos={novosCodigos} onConcluir={async () => { await recarregarUsuario(); onClose(); }} />;
  } else if (modo === 'desativar') {
    corpo = (
      <form className="form-stack" onSubmit={(e) => enviar(e, '/auth/2fa/desativar', async () => { await recarregarUsuario(); toast.sucesso('Verificação em duas etapas desativada.'); onClose(); })}>
        <p>Para desativar, confirme sua senha e um código atual do app.</p>
        {campos}
        <div className="modal-actions"><button type="button" onClick={() => setModo('inicio')}>Voltar</button><button type="submit" disabled={form.codigo.length !== 6}>Desativar</button></div>
      </form>
    );
  } else if (modo === 'codigos') {
    corpo = (
      <form className="form-stack" onSubmit={(e) => enviar(e, '/auth/2fa/codigos-recuperacao', (d) => { setNovosCodigos(d.codigos_recuperacao); setModo('mostrar'); })}>
        <p>Gerar novos códigos invalida os anteriores. Confirme sua senha e um código atual do app.</p>
        {campos}
        <div className="modal-actions"><button type="button" onClick={() => setModo('inicio')}>Voltar</button><button type="submit" disabled={form.codigo.length !== 6}>Gerar códigos</button></div>
      </form>
    );
  } else {
    corpo = (
      <div className="form-stack">
        <p>Situação: {df.ativo ? <span className="badge selo-ok">Ativa</span> : <span className="badge-inativo">Não ativa</span>}{obrigatorio && <span className="badge" style={{ marginLeft: 6 }}>Obrigatória</span>}</p>
        {df.ativo && <p className="muted">Códigos de recuperação restantes: {df.codigosRestantes}</p>}
        {!df.ativo && <p>Com a verificação em duas etapas, além da senha é preciso um código do app autenticador do seu celular para entrar.</p>}
        {df.ativo && obrigatorio && <p className="muted">Esta conta precisa manter a verificação ativa. Para trocar de celular, peça a um administrador para resetá-la.</p>}
        {df.ativo && (
          <div className="row-actions">
            <button type="button" className="btn-link" onClick={() => abrir('codigos')}>Gerar novos códigos de recuperação</button>
            {!obrigatorio && <button type="button" className="btn-link perigo" onClick={() => abrir('desativar')}>Desativar</button>}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Fechar</button>
          {!df.ativo && <button type="button" onClick={() => abrir('ativar')}>Ativar</button>}
        </div>
      </div>
    );
  }
  return <Modal titulo="Verificação em duas etapas" onClose={modo === 'mostrar' || modo === 'ativar' ? undefined : onClose}>{corpo}</Modal>;
}

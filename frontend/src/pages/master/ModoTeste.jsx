import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/UiContext.jsx';
import { Modal } from '../../components/ui.jsx';
import ModoTesteModal from '../../components/ModoTesteModal.jsx';
import { dataHora } from '../../utils/format';

// Aba Modo teste do painel Master (banco de teste separado da producao).
export default function ModoTeste() {
  const { user, alternarModoTeste } = useAuth();
  const toast = useToast();
  const [st, setSt] = useState(null);
  const [erro, setErro] = useState('');
  const [ligando, setLigando] = useState(false);
  const [copiando, setCopiando] = useState(false);

  const carregar = useCallback(async () => {
    try { setSt(await api.get('/master/modo-teste/status')); setErro(''); } catch (err) { setErro(err.message); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  async function desligar() {
    try { await alternarModoTeste(false); window.location.assign('/'); } catch (err) { toast.erro(err); }
  }

  const totalProd = st ? st.tabelas.reduce((s, t) => s + t.producao, 0) : 0;
  const totalTeste = st && st.ultimaCopia ? st.tabelas.reduce((s, t) => s + (t.teste || 0), 0) : null;

  return (
    <div>
      <div className="card">
        <div className="card-titulo-acoes">
          <h3>Modo teste</h3>
          {user.modoTeste
            ? <button type="button" className="btn-primario" onClick={desligar}>Voltar à produção</button>
            : <button type="button" className="btn-primario" disabled={!st || !st.configurado} onClick={() => setLigando(true)}>Ligar modo teste</button>}
        </div>
        <p className="muted">
          O modo teste usa um <b>segundo banco de dados</b>, com a mesma estrutura, para testar sem afetar a produção. Vale só para a sessão que o ligou.
          Usuários criados dentro do teste ficam só no teste e <b>não conseguem entrar</b> (o login é sempre na produção).
        </p>
        {erro && <p className="es-erro">{erro}</p>}
        {st && !st.configurado && <div className="ped-nota">Modo teste não configurado: defina <code>DATABASE_URL_TESTE</code> (outro banco) no servidor.</div>}
        {user.modoTeste && user.empresaTeste && <div className="ped-nota">Testando como <b>{user.empresaTeste.nome}</b> (Administrador, só no banco de teste).</div>}

        {st && st.configurado && (
          <>
            <div className="es-kpis" style={{ marginTop: 12 }}>
              <div className="es-kpi"><small>Última cópia</small><b style={{ fontSize: 15 }}>{st.ultimaCopia ? dataHora(st.ultimaCopia.copiado_em) : 'nunca'}</b></div>
              <div className="es-kpi"><small>Registros na produção</small><b>{totalProd}</b></div>
              <div className="es-kpi"><small>Registros no teste</small><b>{totalTeste === null ? '—' : totalTeste}</b></div>
              <div className="es-kpi"><small>Clientes anonimizados</small><b style={{ fontSize: 15 }}>{st.ultimaCopia ? (st.ultimaCopia.anonimizado ? 'sim' : 'não') : '—'}</b></div>
            </div>
            {st.copiaEmAndamento && <div className="ped-nota">Cópia em andamento...</div>}
            <div className="cl-linha-btn" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
              <button type="button" className="btn-link perigo" disabled={st.copiaEmAndamento} onClick={() => setCopiando(true)}>Copiar tudo da produção</button>
            </div>

            <h4 style={{ margin: '18px 0 6px' }}>Registros por tabela</h4>
            <div className="tabela-wrap">
              <table className="compacta">
                <thead><tr><th>Tabela</th><th className="num">Produção</th><th className="num">Teste</th></tr></thead>
                <tbody>
                  {st.tabelas.map((t) => (
                    <tr key={t.tabela}><td>{t.tabela}</td><td className="num">{t.producao}</td><td className="num">{t.teste === null ? '—' : t.teste}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {ligando && <ModoTesteModal empresas={st ? st.empresas : []} onClose={() => setLigando(false)} />}
      {copiando && <CopiarModal onClose={() => setCopiando(false)} onFeito={() => { setCopiando(false); carregar(); }} />}
    </div>
  );
}

function CopiarModal({ onClose, onFeito }) {
  const toast = useToast();
  const [texto, setTexto] = useState('');
  const [anonimizar, setAnonimizar] = useState(true);
  const [copiando, setCopiando] = useState(false);

  async function copiar(e) {
    e.preventDefault();
    if (texto !== 'COPIAR') return;
    setCopiando(true);
    try {
      await api.post('/master/modo-teste/copiar-producao', { confirmacao: 'COPIAR', anonimizar });
      toast.sucesso('Produção copiada para o banco de teste.');
      onFeito();
    } catch (err) { toast.erro(err); setCopiando(false); }
  }

  return (
    <Modal titulo="Copiar tudo da produção" onClose={copiando ? undefined : onClose}>
      <form className="form-stack" onSubmit={copiar}>
        <div className="ped-nota" style={{ borderColor: 'var(--err)' }}>
          <b>Isto substitui TODOS os dados de teste</b> pela cópia atual da produção. A produção não é alterada. A cópia é só produção → teste.
        </div>
        <label className="cli-check"><input type="checkbox" checked={anonimizar} onChange={(e) => setAnonimizar(e.target.checked)} /> Anonimizar nomes e telefones de clientes ao copiar</label>
        <label className="field"><span className="field-label">Digite COPIAR para confirmar</span>
          <input value={texto} onChange={(e) => setTexto(e.target.value)} autoFocus autoComplete="off" />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={copiando}>Cancelar</button>
          <button type="submit" disabled={copiando || texto !== 'COPIAR'}>{copiando ? 'Copiando...' : 'Copiar tudo da produção'}</button>
        </div>
      </form>
    </Modal>
  );
}

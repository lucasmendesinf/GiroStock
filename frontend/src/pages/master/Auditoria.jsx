import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { quando } from './util.js';

const VAZIO = { tipo: '', empresa_id: '', usuario_id: '', de: '', ate: '', q: '' };

function resumo(d) {
  if (!d || typeof d !== 'object') return '';
  const t = Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
  return t.length > 140 ? `${t.slice(0, 140)}…` : t;
}

export default function Auditoria() {
  const toast = useToast();
  const [filtros, setFiltros] = useState(VAZIO);
  const [pagina, setPagina] = useState(1);
  const [verTeste, setVerTeste] = useState(false);
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [empresas, setEmpresas] = useState([]);
  const [usuarios, setUsuarios] = useState([]);

  const qs = useCallback((extra = {}) => {
    const p = new URLSearchParams();
    Object.entries({ ...filtros, ...extra }).forEach(([k, v]) => { if (v) p.set(k, v); });
    if (verTeste) p.set('teste', '1');
    return p.toString();
  }, [filtros, verTeste]);

  const carregar = useCallback(async () => {
    try { setDados(await api.get(`/master/auditoria?${qs({ pagina: pagina > 1 ? pagina : '' })}`)); setErro(null); } catch (err) { setErro(err.message); }
  }, [qs, pagina]);

  useEffect(() => { const t = setTimeout(carregar, 200); return () => clearTimeout(t); }, [carregar]);
  useEffect(() => { api.get(`/master/empresas${verTeste ? '?teste=1' : ''}`).then((r) => setEmpresas(r.empresas)).catch(() => {}); }, [verTeste]);
  // Usuarios da empresa escolhida (ou todos) para o filtro "usuario".
  useEffect(() => {
    const q = [filtros.empresa_id && `empresa_id=${filtros.empresa_id}`, verTeste && 'teste=1'].filter(Boolean).join('&');
    api.get(`/master/usuarios${q ? `?${q}` : ''}`).then((r) => setUsuarios(r.usuarios)).catch(() => setUsuarios([]));
  }, [filtros.empresa_id, verTeste]);

  function mudar(campo, valor) {
    setFiltros((f) => ({ ...f, [campo]: valor, ...(campo === 'empresa_id' ? { usuario_id: '' } : {}) }));
    setPagina(1);
  }

  async function exportar() {
    try {
      const res = await fetch(`/api/master/auditoria/exportar?${qs()}`, { headers: { Authorization: `Bearer ${localStorage.getItem('girostock_token')}` } });
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'auditoria-girostock.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { toast.erro(err); }
  }

  return (
    <div>
      <div className="ped-head" style={{ marginTop: 6 }}>
        <h3 style={{ margin: 0 }}>Auditoria geral</h3>
        <button type="button" className="btn-primario" onClick={exportar}>Exportar CSV</button>
      </div>
      <p className="cl-sub" style={{ marginTop: 0 }}>Tudo o que ficou registrado, de todas as empresas e do próprio Master. Este registro <b>não pode ser editado nem apagado</b>.</p>

      <div className="ped-bar">
        <select value={filtros.tipo} onChange={(e) => mudar('tipo', e.target.value)} aria-label="Tipo" style={{ width: 'auto' }}>
          <option value="">Todos os tipos</option>
          {dados && dados.tipos.map((t) => <option key={t.codigo} value={t.codigo}>{t.rotulo}</option>)}
          <option value="outros">Outros</option>
        </select>
        <select value={filtros.empresa_id} onChange={(e) => mudar('empresa_id', e.target.value)} aria-label="Empresa" style={{ width: 'auto' }}>
          <option value="">Todas as empresas</option>
          {empresas.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
        </select>
        <select value={filtros.usuario_id} onChange={(e) => mudar('usuario_id', e.target.value)} aria-label="Usuário" style={{ width: 'auto' }}>
          <option value="">Todos os usuários</option>
          {usuarios.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
        </select>
        <input type="date" value={filtros.de} onChange={(e) => mudar('de', e.target.value)} aria-label="De" style={{ width: 'auto' }} />
        <input type="date" value={filtros.ate} onChange={(e) => mudar('ate', e.target.value)} aria-label="Até" style={{ width: 'auto' }} />
        <input className="ped-busca" style={{ maxWidth: 260 }} value={filtros.q} onChange={(e) => mudar('q', e.target.value)} placeholder="Buscar na ação ou no detalhe" aria-label="Buscar" />
        <label className="check-linha" title="Empresas e usuários criados pelos testes automatizados (E2E) ficam ocultos por padrão"><input type="checkbox" checked={verTeste} onChange={(e) => setVerTeste(e.target.checked)} /> Mostrar dados de teste (E2E)</label>
        {Object.values(filtros).some(Boolean) && <button type="button" className="btn-link" onClick={() => { setFiltros(VAZIO); setPagina(1); }}>Limpar filtros</button>}
      </div>

      {erro && <p className="error" role="alert">{erro}</p>}
      <div className="card">
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Quando</th><th>Quem</th><th>Empresa</th><th>Tipo</th><th>Detalhe</th></tr></thead>
            <tbody>
              {dados && dados.itens.map((i) => (
                <tr key={i.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{quando(i.criado_em)}</td>
                  <td>{i.usuario_nome || <span className="muted">—</span>}</td>
                  <td>{i.empresa_nome || <span className="muted">—</span>}</td>
                  <td><span className="ped-tag">{i.tipo_rotulo}</span></td>
                  <td><b>{i.acao}</b>{i.recurso ? <span className="cl-sub">{i.recurso}</span> : null}{i.detalhes ? <span className="cl-sub">{resumo(i.detalhes)}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {dados && dados.itens.length === 0 && <div className="ped-vazio">Nenhum registro neste filtro.</div>}
        {dados && (
          <div className="vg-paginacao">
            <span className="cl-sub" style={{ margin: 0 }}>{dados.total} registro(s) · página {dados.pagina} de {dados.paginas}</span>
            <span>
              <button type="button" className="btn-link" disabled={pagina <= 1} onClick={() => setPagina(pagina - 1)}>Anterior</button>{' '}
              <button type="button" className="btn-link" disabled={pagina >= dados.paginas} onClick={() => setPagina(pagina + 1)}>Próxima</button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

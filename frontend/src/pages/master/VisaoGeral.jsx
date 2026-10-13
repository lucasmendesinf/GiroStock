import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { quando } from './util.js';

const ROTULO = { ok: 'Operando', atencao: 'Atenção', erro: 'Com problema', indisponivel: 'Indisponível' };
const LIMIAR_ERROS_HORA = 3;

function bytes(n) {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1).replace('.', ',')} ${u[i]}`;
}

function duracao(seg) {
  const d = Math.floor(seg / 86400); const h = Math.floor((seg % 86400) / 3600); const m = Math.floor((seg % 3600) / 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
  return `${m} min`;
}

function Estado({ status, children }) {
  return <div className="vg-estado"><span className={`vg-dot ${status}`} />{children}</div>;
}

function Recurso({ rotulo, dado, valor }) {
  if (!dado || dado.status === 'indisponivel') {
    return <div className="vg-recurso"><div className="vg-linha"><span>{rotulo}</span><b className="muted">indisponível</b></div><div className="cl-sub">{dado && dado.motivo}</div></div>;
  }
  return (
    <div className="vg-recurso">
      <div className="vg-linha"><span>{rotulo}</span><b>{valor}</b></div>
      <div className="vg-barra"><i className={dado.status === 'ok' ? '' : dado.status} style={{ width: `${Math.min(100, dado.usoPct)}%` }} /></div>
    </div>
  );
}

export default function VisaoGeral() {
  const toast = useToast();
  const [saude, setSaude] = useState(null);
  const [uso, setUso] = useState(null);
  const [erros, setErros] = useState(null);
  const [falha, setFalha] = useState(null);
  const [verificando, setVerificando] = useState(false);

  // Atualiza em segundo plano: mantém o que já está na tela (sem piscar) e só troca quando chegam os novos dados.
  const carregar = useCallback(async (manual = false) => {
    if (manual) setVerificando(true);
    try {
      const [s, u, e] = await Promise.all([api.get('/master/saude'), api.get('/master/uso'), api.get('/master/erros?horas=24')]);
      setSaude(s); setUso(u); setErros(e); setFalha(null);
      if (manual) toast.sucesso('Verificação concluída.');
    } catch (err) { setFalha(err.message); if (manual) toast.erro(err); } finally { setVerificando(false); }
  }, [toast]);

  useEffect(() => {
    carregar();
    const t = setInterval(() => carregar(), 45000);
    return () => clearInterval(t);
  }, [carregar]);

  if (!saude && !falha) return <p className="muted">Carregando…</p>;
  if (!saude) return <div className="card"><p className="error" role="alert">{falha}</p><button type="button" className="btn-link" onClick={() => carregar(true)}>Tentar de novo</button></div>;

  const { api: a, banco, bancoTeste, recursos } = saude;
  const maxErro = erros ? Math.max(LIMIAR_ERROS_HORA, ...erros.por_hora.map((h) => h.total)) : 1;

  return (
    <div>
      <div className="ped-head" style={{ marginTop: 6 }}>
        <h3 style={{ margin: 0 }}>Visão geral do sistema</h3>
        <span className="cl-sub" style={{ margin: 0 }}>
          atualizado {quando(saude.verificadoEm)} · <button type="button" className="btn-link" disabled={verificando} onClick={() => carregar(true)}>{verificando ? 'verificando…' : 'verificar de novo'}</button>
        </span>
      </div>
      {falha && <p className="error" role="alert">Não foi possível atualizar agora: {falha}</p>}

      <div className="vg-grid vg-g4">
        <div className="card vg-card"><small className="vg-titulo">Backend (API)</small>
          <Estado status={a.status}>{ROTULO[a.status]}</Estado>
          <span className="cl-sub">no ar há {duracao(a.uptimeSeg)}{a.versao ? ` · v${a.versao}` : ''}{a.commit ? ` · ${a.commit}` : ''}</span></div>
        <div className="card vg-card"><small className="vg-titulo">Banco de dados</small>
          <Estado status={banco.status}>{banco.online ? (banco.status === 'erro' ? 'Com problema' : 'Conectado') : 'Fora do ar'}</Estado>
          {banco.online
            ? <span className="cl-sub">PostgreSQL {banco.versao} · {banco.latenciaMs} ms · migrations {banco.migrations ? `${banco.migrations.aplicadas}/${banco.migrations.arquivos}` : '—'}</span>
            : <span className="cl-sub">{banco.mensagem}</span>}
          {banco.migrations && banco.migrations.pendentes.length > 0 && <span className="error" style={{ display: 'block' }}>Migration pendente: {banco.migrations.pendentes.join(', ')}</span>}</div>
        <div className="card vg-card"><small className="vg-titulo">Banco de teste</small>
          <Estado status={bancoTeste.status}>{bancoTeste.status === 'indisponivel' ? 'Não configurado' : bancoTeste.online ? (bancoTeste.status === 'erro' ? 'Com problema' : 'Conectado') : 'Fora do ar'}</Estado>
          {bancoTeste.online
            ? <span className="cl-sub">{bancoTeste.latenciaMs} ms · migrations {bancoTeste.migrations ? `${bancoTeste.migrations.aplicadas}/${bancoTeste.migrations.arquivos}` : '—'}{bancoTeste.migrations && bancoTeste.migrations.pendentes.length > 0 ? ' · pendente' : ''}</span>
            : <span className="cl-sub">{bancoTeste.motivo || bancoTeste.mensagem}</span>}</div>
        <div className="card vg-card"><small className="vg-titulo">Impressão e e-mail</small>
          <Estado status="indisponivel">Não monitorado</Estado>
          <span className="cl-sub">o sistema ainda não tem fila de impressão nem envio de e-mail</span></div>
      </div>

      <div className="vg-grid vg-g3">
        <div className="card"><h4 style={{ margin: '0 0 10px' }}>Recursos do servidor</h4>
          <Recurso rotulo="Disco" dado={recursos.disco} valor={recursos.disco.totalBytes ? `${bytes(recursos.disco.totalBytes - recursos.disco.livreBytes)} / ${bytes(recursos.disco.totalBytes)}` : ''} />
          <Recurso rotulo="Memória do servidor" dado={recursos.memoria} valor={`${bytes(recursos.memoria.totalBytes - recursos.memoria.livreBytes)} / ${bytes(recursos.memoria.totalBytes)}`} />
          <Recurso rotulo="Carga do processador" dado={recursos.carga} valor={`${recursos.carga.usoPct}%`} />
          <div className="vg-linha"><span>Memória da aplicação</span><b>{bytes(recursos.memoria.processoBytes)}</b></div>
          <div className="vg-linha"><span>Tamanho do banco</span><b>{bytes(banco.tamanhoBytes)}</b></div></div>

        <div className="card"><h4 style={{ margin: '0 0 10px' }}>Uso hoje (plataforma)</h4>
          {uso ? (
            <>
              <div className="vg-linha"><span>Empresas ativas hoje</span><b>{uso.empresas_ativas_hoje}</b></div>
              <div className="vg-linha"><span>Usuários online agora</span><b>{uso.usuarios_online}</b></div>
              <div className="vg-linha"><span>Usuários cadastrados</span><b>{uso.usuarios_cadastrados}</b></div>
              <div className="vg-linha"><span>Lojas ativas</span><b>{uso.lojas_ativas}</b></div>
              <div className="vg-linha"><span>Requisições/min (pico, 60 min)</span><b>{uso.requisicoes_por_min_pico}</b></div>
              <span className="cl-sub">“Online” = com atividade nos últimos 5 minutos. O contador de requisições recomeça quando o servidor reinicia.</span>
            </>
          ) : <p className="muted">—</p>}</div>

        <div className="card"><h4 style={{ margin: '0 0 6px' }}>Erros nas últimas 24 h</h4>
          {erros ? (
            <>
              <div className="vg-grande">{erros.total} <span className="cl-sub" style={{ display: 'inline' }}>erro(s) 5xx</span></div>
              <div className="vg-grafico" role="img" aria-label="Erros por hora nas últimas 24 horas">
                {erros.por_hora.map((h) => (
                  <span key={h.hora} className={h.total > LIMIAR_ERROS_HORA ? 'alto' : ''} style={{ height: `${Math.max(4, (h.total / maxErro) * 100)}%` }} title={`${new Date(h.hora).getHours()}h: ${h.total}`} />
                ))}
              </div>
              <span className="cl-sub">por hora · barras vermelhas = mais de {LIMIAR_ERROS_HORA} na hora</span>
            </>
          ) : <p className="muted">—</p>}</div>
      </div>

      <div className="card">
        <h4 style={{ margin: '0 0 8px' }}>Últimos erros</h4>
        {erros && erros.ultimos.length > 0 ? (
          <div className="tabela-wrap">
            <table>
              <thead><tr><th>Hora</th><th>Rota</th><th>Código</th><th>Mensagem</th><th>Empresa</th></tr></thead>
              <tbody>
                {erros.ultimos.map((e) => (
                  <tr key={e.id}>
                    <td>{quando(e.criado_em)}</td>
                    <td><code>{e.metodo} {e.rota}</code></td>
                    <td><span className={`ped-pill ${e.status >= 500 ? 'err' : 'warn'}`}>{e.status}</span></td>
                    <td>{e.mensagem}</td>
                    <td>{e.empresa_nome || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="ped-vazio">Nenhum erro registrado. Os erros ficam guardados por 30 dias.</div>}
      </div>

      <div className="card">
        <h4 style={{ margin: '0 0 8px' }}>Ações rápidas</h4>
        <div className="row-actions">
          <NavLink className="btn-link" to="/master/modo-teste">Modo teste</NavLink>
          <NavLink className="btn-link" to="/master/auditoria">Auditoria</NavLink>
          <NavLink className="btn-link" to="/master/backups">Gerar backup</NavLink>
          <NavLink className="btn-link" to="/master/config">Aviso a todos</NavLink>
          <NavLink className="btn-link" to="/master/config">Modo manutenção</NavLink>
        </div>
      </div>

      <p className="cl-sub">Disco, memória e processador só aparecem quando o servidor permite a leitura; em hospedagem compartilhada (cPanel) alguns ficam “indisponíveis” e o painel mostra o que for possível. O Master não vê vendas, pedidos nem clientes das empresas.</p>
    </div>
  );
}

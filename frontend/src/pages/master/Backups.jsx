import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { baixarArquivo, bytes, quando } from './util.js';

const SITUACAO = { gerando: ['warn', 'Gerando…'], concluido: ['ok', 'Concluído'], falhou: ['err', 'Falhou'] };

function dataHora(v) { return v ? new Date(v).toLocaleString('pt-BR') : '—'; }

export default function Backups() {
  const toast = useToast();
  const confirmar = useConfirm();
  const [dados, setDados] = useState(null);
  const [gerando, setGerando] = useState(false);
  const [restaurar, setRestaurar] = useState(null);
  const [empresas, setEmpresas] = useState([]);
  const [empresaId, setEmpresaId] = useState('');
  const [exportado, setExportado] = useState(null);
  const [exportando, setExportando] = useState(false);
  const [banco, setBanco] = useState('producao');
  const [saldos, setSaldos] = useState(null);
  const [ocupado, setOcupado] = useState('');
  const [corrigir, setCorrigir] = useState(false);
  const temporizador = useRef(null);

  const carregar = useCallback(async () => {
    try { setDados(await api.get('/master/backups')); } catch (err) { toast.erro(err); }
  }, [toast]);
  useEffect(() => { carregar(); api.get('/master/empresas').then((r) => setEmpresas(r.empresas)).catch(() => {}); }, [carregar]);

  // Enquanto algo estiver "gerando", consulta o registro a cada 2 s (estado real, nao uma barra fingida).
  const emAndamento = dados && dados.backups.some((b) => b.status === 'gerando');
  useEffect(() => {
    if (!emAndamento && !gerando) return undefined;
    temporizador.current = setInterval(carregar, 2000);
    return () => clearInterval(temporizador.current);
  }, [emAndamento, gerando, carregar]);

  async function gerar() {
    setGerando(true);
    try {
      const r = await api.post('/master/backups');
      toast.sucesso(`Backup gerado: ${bytes(r.backup.tamanho_bytes)}.`);
    } catch (err) { toast.erro(err); } finally { setGerando(false); carregar(); }
  }
  async function baixar(b) {
    try { await baixarArquivo(`/api/master/backups/${b.id}/download`, b.arquivo); } catch (err) { toast.erro(err); }
  }
  async function remover(b) {
    if (!(await confirmar({ titulo: 'Remover este backup?', mensagem: `${b.arquivo} será apagado do servidor. Esta ação não pode ser desfeita.`, confirmar: 'Remover', perigo: true }))) return;
    try { await api.del(`/master/backups/${b.id}`); toast.sucesso('Backup removido.'); carregar(); } catch (err) { toast.erro(err); }
  }
  async function exportar() {
    setExportando(true); setExportado(null);
    try { setExportado(await api.post(`/master/empresas/${empresaId}/exportar`)); } catch (err) { toast.erro(err); } finally { setExportando(false); }
  }
  async function verificar() {
    setOcupado('verificar'); setSaldos(null);
    try { setSaldos(await api.post('/master/manutencao/saldos', { empresa_id: empresaId || undefined, banco })); } catch (err) { toast.erro(err); } finally { setOcupado(''); }
  }
  async function otimizar() {
    if (!(await confirmar({ titulo: 'Otimizar o banco?', mensagem: 'Roda o ANALYZE (atualiza estatísticas). É rápido e não bloqueia o uso, mas pode levar alguns segundos em bancos grandes.', confirmar: 'Otimizar' }))) return;
    setOcupado('otimizar');
    try { const r = await api.post('/master/manutencao/otimizar'); toast.sucesso(`Banco otimizado em ${(r.duracao_ms / 1000).toFixed(1)} s.`); } catch (err) { toast.erro(err); } finally { setOcupado(''); }
  }

  if (!dados) return <p className="muted">Carregando…</p>;
  const ultimo = dados.backups.find((b) => b.status === 'concluido');

  return (
    <div>
      <div className="ped-head" style={{ marginTop: 6 }}>
        <h3 style={{ margin: 0 }}>Backups & dados</h3>
        <button type="button" className="btn-primario" disabled={gerando || emAndamento || !dados.pasta.ok} onClick={gerar}>{gerando || emAndamento ? 'Gerando backup…' : 'Gerar backup agora'}</button>
      </div>
      {!dados.pasta.ok && <p className="error" role="alert">{dados.pasta.erro}. Defina a variável BACKUP_DIR com uma pasta gravável fora da pasta do site.</p>}

      <div className="vg-grid vg-g3">
        <div className="card vg-card"><small className="vg-titulo">Último backup</small>
          <div className="vg-estado">{ultimo ? quando(ultimo.criado_em) : 'nenhum'}</div>
          <span className="cl-sub">{ultimo ? `${bytes(ultimo.tamanho_bytes)} · ${ultimo.tipo}` : 'gere o primeiro agora'}</span></div>
        <div className="card vg-card"><small className="vg-titulo">Rotina automática</small>
          <div className="vg-estado"><span className={`vg-dot ${dados.rotina.automatico ? 'ok' : 'indisponivel'}`} />{dados.rotina.automatico ? `Todo dia às ${dados.rotina.hora}` : 'Desligada'}</div>
          <span className="cl-sub">guarda os automáticos por {dados.rotina.retencao_dias} dias (os manuais ficam até você remover) · muda em Configurações globais</span></div>
        <div className="card vg-card"><small className="vg-titulo">Espaço usado</small>
          <div className="vg-estado">{bytes(dados.usado_bytes)}</div>
          <span className="cl-sub">{dados.backups.filter((b) => b.status === 'concluido').length} backup(s) · formato {dados.pg_dump ? 'pg_dump' : 'próprio (sem pg_dump no servidor)'}</span></div>
      </div>

      <div className="card">
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Data</th><th>Tipo</th><th>Tamanho</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {dados.backups.map((b) => {
                const [cls, rotulo] = SITUACAO[b.status] || ['warn', b.status];
                return (
                  <tr key={b.id}>
                    <td>{dataHora(b.criado_em)}<span className="cl-sub">{b.arquivo || ''}</span></td>
                    <td><span className="ped-tag">{b.tipo === 'automatico' ? 'Automático' : 'Manual'}</span></td>
                    <td>{b.tamanho_bytes ? bytes(b.tamanho_bytes) : '—'}</td>
                    <td><span className={`ped-pill ${cls}`}>{rotulo}</span>{b.erro && <span className="cl-sub">{b.erro}</span>}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {b.status === 'concluido' && <button type="button" className="btn-link" onClick={() => baixar(b)}>Baixar</button>}{' '}
                      {b.status === 'concluido' && <button type="button" className="btn-link" disabled={!dados.teste_configurado} title={dados.teste_configurado ? '' : 'Banco de teste não configurado'} onClick={() => setRestaurar(b)}>Restaurar no teste</button>}{' '}
                      {b.status !== 'gerando' && <button type="button" className="btn-link perigo" onClick={() => remover(b)}>Remover</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {dados.backups.length === 0 && <div className="ped-vazio">Nenhum backup ainda.</div>}
      </div>

      <div className="card">
        <h4 style={{ margin: '0 0 6px' }}>Restaurar na produção</h4>
        <p className="cl-sub" style={{ margin: 0 }}>Não há botão para isso, de propósito. Para restaurar na produção, use o procedimento no servidor: <code>BACKUP_ARQUIVO=nome-do-arquivo npm run restaurar-backup</code>. O script mostra a data do backup, quantos registros serão perdidos, pede confirmação digitada, cria um backup de segurança antes e coloca o sistema em modo manutenção durante a operação.</p>
      </div>

      <div className="card">
        <h4 style={{ margin: '0 0 6px' }}>Dados por empresa</h4>
        <p className="cl-sub" style={{ margin: '0 0 8px' }}>Gera um arquivo com todos os dados de uma empresa (para LGPD ou migração). Senhas e segredos de 2FA nunca entram. Cada exportação fica registrada na auditoria.</p>
        <div className="ped-bar">
          <select value={empresaId} onChange={(e) => { setEmpresaId(e.target.value); setExportado(null); setSaldos(null); }} aria-label="Empresa" style={{ width: 'auto' }}>
            <option value="">Escolha a empresa…</option>
            {empresas.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
          </select>
          <button type="button" className="btn-link" disabled={!empresaId || exportando || !dados.pasta.ok} onClick={exportar}>{exportando ? 'Gerando…' : 'Exportar dados'}</button>
          {exportado && <button type="button" className="btn-primario" onClick={() => baixarArquivo(`/api/master/exportacoes/${exportado.arquivo}`, exportado.arquivo).catch((e) => toast.erro(e))}>Baixar ({bytes(exportado.tamanho_bytes)})</button>}
        </div>
        {exportado && <span className="cl-sub">Pronto: {Object.values(exportado.contagens).reduce((s, n) => s + n, 0)} registros em {Object.keys(exportado.contagens).length} tabelas.</span>}
      </div>

      <div className="card">
        <h4 style={{ margin: '0 0 6px' }}>Manutenção</h4>
        <p className="cl-sub" style={{ margin: '0 0 8px' }}>Nada aqui apaga dados. “Verificar saldos” compara o saldo de cada produto com a soma dos movimentos e só relata as diferenças (insumos não entram: não têm histórico de movimentos).</p>
        <div className="ped-bar">
          <select value={banco} onChange={(e) => { setBanco(e.target.value); setSaldos(null); }} aria-label="Banco" style={{ width: 'auto' }}>
            <option value="producao">Banco de produção</option>
            {dados.teste_configurado && <option value="teste">Banco de teste</option>}
          </select>
          <button type="button" className="btn-link" disabled={ocupado === 'verificar'} onClick={verificar}>{ocupado === 'verificar' ? 'Verificando…' : 'Verificar saldos de estoque'}</button>
          <button type="button" className="btn-link" disabled={ocupado === 'otimizar'} onClick={otimizar}>{ocupado === 'otimizar' ? 'Otimizando…' : 'Otimizar banco'}</button>
        </div>
        {saldos && (
          <div style={{ marginTop: 10 }}>
            {saldos.total === 0 ? <p className="success">Nenhuma divergência{empresaId ? ' nesta empresa' : ''}.</p> : (
              <>
                <p className="error">{saldos.total} divergência(s) encontrada(s){saldos.total >= 1000 ? ' (mostrando as primeiras 1000)' : ''}.</p>
                <div className="tabela-wrap">
                  <table className="tabela-cartoes">
                    <thead><tr><th>Empresa</th><th>Produto</th><th>Loja</th><th>Saldo</th><th>Esperado</th><th>Diferença</th></tr></thead>
                    <tbody>{saldos.itens.slice(0, 50).map((i) => <tr key={`${i.product_id}-${i.location_id}`}><td>{i.empresa}</td><td>{i.produto}</td><td>{i.loja}</td><td>{i.saldo}</td><td>{i.esperado}</td><td>{i.diferenca > 0 ? '+' : ''}{i.diferenca}</td></tr>)}</tbody>
                  </table>
                </div>
                {saldos.total > 50 && <span className="cl-sub">Mostrando 50 de {saldos.total}.</span>}
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="btn-link perigo" disabled={!empresaId} title={empresaId ? '' : 'Escolha uma empresa acima para corrigir'} onClick={() => setCorrigir(true)}>Corrigir divergências desta empresa…</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {restaurar && <RestaurarModal backup={restaurar} onClose={() => setRestaurar(null)} onFeito={() => { setRestaurar(null); carregar(); }} />}
      {corrigir && <CorrigirModal empresaId={empresaId} banco={banco} total={saldos ? saldos.total : 0} onClose={() => setCorrigir(false)} onFeito={() => { setCorrigir(false); verificar(); }} />}
    </div>
  );
}

function RestaurarModal({ backup, onClose, onFeito }) {
  const toast = useToast();
  const [conf, setConf] = useState('');
  const [anonimizar, setAnonimizar] = useState(true);
  const [rodando, setRodando] = useState(false);
  async function enviar(e) {
    e.preventDefault();
    setRodando(true);
    try {
      await api.post(`/master/backups/${backup.id}/restaurar-teste`, { confirmacao: conf, anonimizar });
      toast.sucesso('Backup restaurado no banco de teste. A produção não foi alterada.');
      onFeito();
    } catch (err) { toast.erro(err); setRodando(false); }
  }
  return (
    <Modal titulo="Restaurar no banco de teste" subtitulo={backup.arquivo} onClose={rodando ? undefined : onClose}>
      <form onSubmit={enviar} className="form-stack">
        <p className="error" style={{ margin: 0 }}>Isto SUBSTITUI todo o conteúdo do banco de <b>teste</b> pelo backup de {dataHora(backup.criado_em)}. A produção não é tocada. Quem estiver em modo teste ficará indisponível durante a operação.</p>
        <label className="check-linha"><input type="checkbox" checked={anonimizar} onChange={(e) => setAnonimizar(e.target.checked)} /> Anonimizar clientes no teste (recomendado)</label>
        <Field label="Digite RESTAURAR para confirmar"><input value={conf} onChange={(e) => setConf(e.target.value)} autoFocus autoComplete="off" /></Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={rodando}>Cancelar</button>
          <button type="submit" disabled={conf !== 'RESTAURAR' || rodando}>{rodando ? 'Restaurando…' : 'Restaurar no teste'}</button>
        </div>
      </form>
    </Modal>
  );
}

function CorrigirModal({ empresaId, banco, total, onClose, onFeito }) {
  const toast = useToast();
  const [conf, setConf] = useState('');
  async function enviar(e) {
    e.preventDefault();
    try {
      const r = await api.post('/master/manutencao/saldos/corrigir', { empresa_id: empresaId, banco, confirmacao: conf });
      toast.sucesso(`${r.corrigidos} saldo(s) corrigido(s)${r.ignorados.length ? `; ${r.ignorados.length} não puderam ser corrigidos` : ''}.`);
      onFeito();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo="Corrigir divergências de saldo" onClose={onClose}>
      <form onSubmit={enviar} className="form-stack">
        <p style={{ margin: 0 }}>Para cada uma das {total} divergência(s), o saldo passa a ser o que o histórico de movimentos indica, registrando um movimento de <b>balanço</b> auditado (nada é sobrescrito sem rastro). Atenção: produtos com saldo inicial sem movimento de entrada vão para o valor do histórico. Banco: <b>{banco === 'teste' ? 'teste' : 'produção'}</b>.</p>
        <Field label="Digite CORRIGIR para confirmar"><input value={conf} onChange={(e) => setConf(e.target.value)} autoFocus autoComplete="off" /></Field>
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button type="submit" disabled={conf !== 'CORRIGIR'}>Corrigir</button></div>
      </form>
    </Modal>
  );
}

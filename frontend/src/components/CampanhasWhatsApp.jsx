import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useConfirm, useToast } from '../context/UiContext.jsx';
import { Field, Modal, Vazio } from './ui.jsx';
import { brl, dataHora } from '../utils/format';

// Campanhas do WhatsApp (API oficial, modelos de marketing): manda um cupom individual para um segmento de clientes
// (em risco, inativos, aniversariantes...). So recebe quem aceitou mensagens; quem responde SAIR sai da lista sozinho.
export const SEGMENTOS_CAMPANHA = [
  ['risco', 'Em risco (sem pedir há 30 a 59 dias)'], ['inativo', 'Inativos (60 dias ou mais sem pedir)'], ['aniversario', 'Aniversariantes do mês'],
  ['vip', 'VIP'], ['recorrente', 'Recorrentes'], ['novo', 'Novos'], ['todos', 'Todos os clientes'],
];
const NOME_SEG = Object.fromEntries(SEGMENTOS_CAMPANHA.map(([k, n]) => [k, n.replace(/ \(.*\)$/, '')]));
const ST_MODELO = { APPROVED: ['Aprovado', 'ok'], PENDING: ['Em análise na Meta', 'warn'], REJECTED: ['Recusado pela Meta', 'err'], NAO_CRIADO: ['Ainda não criado', 'err'] };
const ST_CAMP = { enviando: ['Enviando', 'warn'], concluida: ['Concluída', 'ok'], cancelada: ['Cancelada', ''] };
const ST_MSG = { na_fila: ['Na fila', ''], enviada: ['Enviada', ''], entregue: ['Entregue', 'ok'], lida: ['Lida', 'ok'], falhou: ['Falhou', 'err'], ignorada: ['Não enviada', ''] };
const descCupom = (c) => (!c.cupom_tipo ? 'sem cupom' : c.cupom_tipo === 'frete_gratis' ? 'frete grátis' : c.cupom_tipo === 'valor' ? `${brl(c.cupom_valor)} de desconto` : `${String(c.cupom_valor).replace('.', ',')}% de desconto`);
const pctDe = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

export default function CampanhasWhatsApp({ inicial }) {
  const toast = useToast();
  const [dados, setDados] = useState(null);
  const [nova, setNova] = useState(inicial || null);
  const [aberta, setAberta] = useState(null);
  const carregar = useCallback(() => api.get('/whatsapp/campanhas').then(setDados).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    if (!dados || !dados.campanhas.some((c) => c.status === 'enviando')) return undefined;
    const t = setInterval(carregar, 5000);
    return () => clearInterval(t);
  }, [dados, carregar]);
  if (!dados) return null;
  const aprovados = dados.modelos.filter((m) => m.status === 'APPROVED').length;
  return (
    <div className="card">
      <div className="toolbar" style={{ marginTop: 0 }}>
        <h3 style={{ margin: 0, flex: 1 }}>Campanhas com cupom</h3>
        <button type="button" className="btn-primario" disabled={!dados.conectado} onClick={() => setNova({ segmento: 'risco' })}>Nova campanha</button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Mande um <b>cupom individual</b> (código próprio, uso único, com validade) para quem não pede há um tempo, para os aniversariantes ou para um grupo de clientes.
        Só recebe quem <b>aceitou receber mensagens</b>; quem responder <b>SAIR</b> deixa de receber sozinho. Cada mensagem de marketing é cobrada pela Meta.
      </p>
      {dados.conectado && aprovados < dados.modelos.length && (
        <div className="ped-nota" style={{ borderColor: 'var(--warn)' }}>
          Modelos de marketing: {aprovados} de {dados.modelos.length} aprovados pela Meta. Os demais aparecem para escolha assim que forem aprovados (normalmente em minutos; clique em "Atualizar modelos").
        </div>
      )}
      {dados.campanhas.length === 0 ? <Vazio>Nenhuma campanha enviada ainda.</Vazio> : (
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Campanha</th><th>Para</th><th>Envio</th><th>Leitura</th><th>Cupons usados</th><th>Vendas</th><th /></tr></thead>
            <tbody>
              {dados.campanhas.map((c) => {
                const [st, cor] = ST_CAMP[c.status] || [c.status, ''];
                return (
                  <tr key={c.id}>
                    <td><b>{c.nome}</b> <span className={`ped-pill ${cor}`}>{st}</span><div className="celula-sub">{dataHora(c.criado_em)} · {descCupom(c)}</div></td>
                    <td>{c.total} cliente(s)<div className="celula-sub">{c.segmento ? NOME_SEG[c.segmento] || c.segmento : 'escolhidos'}</div></td>
                    <td>{c.entregues} entregue(s){c.na_fila > 0 && <div className="celula-sub">{c.na_fila} na fila</div>}{c.falhas > 0 && <div className="celula-sub" style={{ color: 'var(--err)' }}>{c.falhas} falha(s)</div>}</td>
                    <td>{c.lidas} lida(s)<div className="celula-sub">{pctDe(c.lidas, c.entregues)}</div></td>
                    <td>{c.cupom_tipo ? <>{c.cupons_usados}<div className="celula-sub">{pctDe(c.cupons_usados, c.entregues)} de retorno</div></> : '—'}</td>
                    <td>{c.cupom_tipo ? brl(c.vendas) : '—'}</td>
                    <td><button type="button" className="btn-link" onClick={() => setAberta(c.id)}>Detalhes</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {nova && <NovaCampanha modelos={dados.modelos} inicial={nova} dias={dados.dias_entre_campanhas} onClose={() => setNova(null)} onCriada={() => { setNova(null); carregar(); }} />}
      {aberta && <DetalheCampanha id={aberta} onClose={() => { setAberta(null); carregar(); }} />}
    </div>
  );
}

function NovaCampanha({ modelos, inicial, dias, onClose, onCriada }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const aprovados = modelos.filter((m) => m.status === 'APPROVED');
  const padrao = inicial.segmento === 'aniversario' ? 'aniversario' : 'volta';
  const [f, setF] = useState({
    nome: '', segmento: inicial.segmento || 'risco', modelo: (aprovados.find((m) => m.chave === padrao) || aprovados[0] || modelos[0] || {}).chave || 'volta',
    oferta: '', tipo: 'percentual', valor: '10', validade_dias: '7', pedido_minimo: '0',
  });
  const [prev, setPrev] = useState(null);
  const [erroPrev, setErroPrev] = useState('');
  const [enviando, setEnviando] = useState(false);
  const modelo = modelos.find((m) => m.chave === f.modelo) || modelos[0];
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const corpo = {
    nome: f.nome, segmento: f.segmento, modelo: f.modelo, oferta: f.oferta,
    cupom: modelo && modelo.cupom ? { tipo: f.tipo, valor: Number(String(f.valor).replace(',', '.')), validade_dias: Number(f.validade_dias), pedido_minimo: Number(String(f.pedido_minimo).replace(',', '.')) || 0 } : undefined,
  };
  const chave = JSON.stringify(corpo);
  useEffect(() => {
    const t = setTimeout(async () => {
      try { setPrev(await api.post('/whatsapp/campanhas/previa', JSON.parse(chave))); setErroPrev(''); } catch (err) { setPrev(null); setErroPrev(err.message); }
    }, 350);
    return () => clearTimeout(t);
  }, [chave]);

  async function enviar() {
    if (!prev || prev.total === 0) return;
    const ok = await confirmar({
      titulo: `Enviar para ${prev.total} cliente(s)?`,
      mensagem: `Custo estimado na Meta: ${brl(prev.custo_estimado)} (cerca de ${brl(prev.custo_unitario)} por mensagem). As mensagens saem aos poucos e não dá para desfazer as já enviadas.`,
      confirmar: 'Enviar campanha',
    });
    if (!ok) return;
    setEnviando(true);
    try { const r = await api.post('/whatsapp/campanhas', corpo); toast.sucesso(`Campanha criada: ${r.total} mensagem(ns) na fila de envio`); onCriada(); } catch (err) { toast.erro(err); setEnviando(false); }
  }
  const aprovado = modelo && modelo.status === 'APPROVED';
  return (
    <Modal titulo="Nova campanha no WhatsApp" subtitulo="Cada cliente recebe um cupom com código próprio, de uso único." onClose={onClose} largura="larga">
      <div className="form-stack">
        <div className="form-grid">
          <Field label="Nome da campanha (só para você)"><input value={f.nome} onChange={set('nome')} placeholder="Ex.: Volta novembro" maxLength={80} /></Field>
          <Field label="Para quem">
            <select value={f.segmento} onChange={set('segmento')}>{SEGMENTOS_CAMPANHA.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
          </Field>
        </div>
        <div className="field"><span className="field-label">Mensagem</span>
          <div className="wa-modelos-escolha" role="radiogroup">
            {modelos.map((m) => {
              const [st, cor] = ST_MODELO[m.status] || [m.status, ''];
              return (
                <label key={m.chave} className={`wa-aviso ${f.modelo === m.chave ? 'wa-aviso-on' : ''}`}>
                  <input type="radio" name="modelo" checked={f.modelo === m.chave} onChange={() => setF((x) => ({ ...x, modelo: m.chave }))} />
                  <span className="wa-aviso-corpo"><b>{m.titulo}</b>{m.status !== 'APPROVED' && <span className={`ped-pill ${cor}`}>{st}</span>}</span>
                </label>
              );
            })}
          </div>
        </div>
        {modelo && modelo.oferta && (
          <Field label="A oferta (aparece no meio da mensagem)" hint="Uma frase, sem quebra de linha. Ex.: X-Tudo + refri por R$ 28,00">
            <input value={f.oferta} onChange={set('oferta')} maxLength={200} placeholder="X-Tudo + refri por R$ 28,00" />
          </Field>
        )}
        {modelo && modelo.cupom && (
          <div className="form-grid">
            <Field label="Cupom">
              <select value={f.tipo} onChange={set('tipo')}>
                <option value="percentual">% de desconto</option>
                <option value="valor">R$ de desconto</option>
                <option value="frete_gratis">Frete grátis</option>
              </select>
            </Field>
            {f.tipo !== 'frete_gratis' && <Field label={f.tipo === 'percentual' ? 'Desconto (%)' : 'Desconto (R$)'}><input value={f.valor} onChange={set('valor')} inputMode="decimal" /></Field>}
            <Field label="Validade (dias)"><input value={f.validade_dias} onChange={set('validade_dias')} inputMode="numeric" /></Field>
            <Field label="Pedido mínimo (R$)"><input value={f.pedido_minimo} onChange={set('pedido_minimo')} inputMode="decimal" /></Field>
          </div>
        )}
        <div className="wa-previa">
          <div>
            <span className="field-label">Como o cliente recebe</span>
            {prev ? (
              <div className="wa-balao wa-balao-grande">{prev.exemplo.texto}<small>{prev.exemplo.rodape}</small></div>
            ) : <p className="error">{erroPrev || 'Calculando…'}</p>}
            {modelo && modelo.cupom && <p className="celula-sub">O código mostrado é um exemplo: cada cliente recebe o seu. O cupom vale no cardápio digital e na loja virtual, entrando na conta do cliente.</p>}
          </div>
          {prev && (
            <div className="wa-previa-numeros">
              <div className="wa-numero"><b>{prev.total}</b><span>vão receber</span></div>
              <div className="wa-numero"><b>{brl(prev.custo_estimado)}</b><span>custo estimado na Meta</span></div>
              <ul className="celula-sub">
                {prev.sem_consentimento > 0 && <li>{prev.sem_consentimento} fora por não aceitar mensagens</li>}
                {prev.sem_celular > 0 && <li>{prev.sem_celular} fora por não ter celular válido</li>}
                {prev.recentes > 0 && <li>{prev.recentes} fora por já ter recebido campanha nos últimos {dias} dias</li>}
                {prev.acima_do_limite && <li>Limite de 2.000 clientes por campanha</li>}
              </ul>
            </div>
          )}
        </div>
        {!aprovado && modelo && <div className="ped-nota" style={{ borderColor: 'var(--warn)' }}>Este modelo ainda não foi aprovado pela Meta. Você pode montar a campanha, mas só dá para enviar depois da aprovação.</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn-primario" disabled={enviando || !aprovado || !prev || prev.total === 0} onClick={enviar}>
            {enviando ? 'Enviando…' : prev ? `Enviar para ${prev.total} cliente(s)` : 'Enviar'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DetalheCampanha({ id, onClose }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [c, setC] = useState(null);
  const carregar = useCallback(() => api.get(`/whatsapp/campanhas/${id}`).then(setC).catch((err) => toast.erro(err)), [id, toast]);
  useEffect(() => { carregar(); }, [carregar]);
  async function cancelar() {
    if (!(await confirmar({ titulo: 'Cancelar a campanha?', mensagem: 'O que ainda está na fila não é enviado e os cupons não enviados são desativados. O que já foi enviado continua valendo.', confirmar: 'Cancelar campanha', perigo: true }))) return;
    try { const r = await api.post(`/whatsapp/campanhas/${id}/cancelar`, {}); toast.sucesso(`Campanha cancelada: ${r.nao_enviadas} mensagem(ns) não enviada(s)`); carregar(); } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo={c ? c.nome : 'Campanha'} subtitulo={c ? `${dataHora(c.criado_em)} · ${descCupom(c)}${c.criado_por_nome ? ` · por ${c.criado_por_nome}` : ''}` : ''} onClose={onClose} largura="larga">
      {!c ? <p className="muted">Carregando…</p> : (
        <div className="form-stack">
          <div className="wa-previa-numeros wa-numeros-linha">
            <div className="wa-numero"><b>{c.total}</b><span>clientes</span></div>
            <div className="wa-numero"><b>{c.entregues}</b><span>entregues</span></div>
            <div className="wa-numero"><b>{c.lidas}</b><span>lidas</span></div>
            {c.cupom_tipo && <div className="wa-numero"><b>{c.cupons_usados}</b><span>cupons usados</span></div>}
            {c.cupom_tipo && <div className="wa-numero"><b>{brl(c.vendas)}</b><span>em pedidos com o cupom</span></div>}
          </div>
          <div className="tabela-wrap" style={{ maxHeight: '50vh', overflow: 'auto' }}>
            <table className="compacta">
              <thead><tr><th>Cliente</th><th>Cupom</th><th>Situação</th></tr></thead>
              <tbody>
                {c.mensagens.map((m) => {
                  const [st, cor] = ST_MSG[m.situacao] || [m.situacao, ''];
                  return (
                    <tr key={m.id}>
                      <td>{m.cliente || '—'}<div className="celula-sub">+{m.telefone}</div></td>
                      <td>{m.cupom || '—'}{m.cupom_usado && <span className="ped-pill ok" style={{ marginLeft: 6 }}>Usado</span>}{m.cupom_fim && <div className="celula-sub">até {m.cupom_fim.split('-').reverse().slice(0, 2).join('/')}</div>}</td>
                      <td><span className={`ped-pill ${cor}`}>{st}</span>{m.motivo && <div className="celula-sub">{m.motivo}</div>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="modal-actions">
            {c.status === 'enviando' && <button type="button" className="btn-link perigo" onClick={cancelar}>Cancelar campanha</button>}
            <button type="button" onClick={onClose}>Fechar</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

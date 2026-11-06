import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { useConfirm, useToast } from '../context/UiContext.jsx';
import { Field, Modal, Vazio } from '../components/ui.jsx';
import { brl, dataHora } from '../utils/format';
import { podeAcessar } from '../utils/permissions';

// Nota fiscal (modulo "nota_fiscal"): NFC-e emitida direto na SEFAZ, sem custo por nota.
// Abas: notas emitidas (Vendas), configuracao fiscal da loja (Configuracoes), perfis fiscais e dados fiscais dos produtos (Estoque).
const NOME_SITUACAO = { processando: 'Processando', autorizada: 'Autorizada', contingencia: 'Contingência', rejeitada: 'Rejeitada', erro: 'Erro', cancelada: 'Cancelada' };
const COR_SITUACAO = { autorizada: 'ok', contingencia: 'warn', rejeitada: 'err', erro: 'err', cancelada: '', processando: 'warn' };
const CSOSN = {
  101: '101 · Tributada com permissão de crédito', 102: '102 · Tributada sem permissão de crédito', 103: '103 · Isenta do ICMS (faixa de receita)',
  201: '201 · Com crédito e com ST', 202: '202 · Sem crédito e com ST', 203: '203 · Isenta e com ST', 300: '300 · Imune', 400: '400 · Não tributada',
  500: '500 · ICMS cobrado antes por ST (ex.: bebidas, cigarro)', 900: '900 · Outros',
};
const ORIGEM = { 0: '0 · Nacional', 1: '1 · Estrangeira (importação direta)', 2: '2 · Estrangeira (mercado interno)' };
const cnpjFmt = (c) => String(c || '').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

export default function NotaFiscal() {
  const { user } = useAuth();
  const abas = [
    podeAcessar(user, 'Vendas') && ['notas', 'Notas emitidas'],
    podeAcessar(user, 'Configuracoes') && ['config', 'Configuração da loja'],
    podeAcessar(user, 'Estoque') && ['produtos', 'Produtos (NCM)'],
    podeAcessar(user, 'Estoque') && ['perfis', 'Perfis fiscais'],
  ].filter(Boolean);
  const estado = useLocation().state || {};
  const [aba, setAba] = useState(estado.aba && abas.some(([k]) => k === estado.aba) ? estado.aba : abas.length ? abas[0][0] : null);
  return (
    <div className="page">
      <div className="page-header"><h2>Nota fiscal</h2></div>
      <div className="ped-bar" role="tablist">
        {abas.map(([k, n]) => (
          <button key={k} type="button" role="tab" aria-selected={aba === k} className={`btn-link ${aba === k ? 'ativo' : ''}`} onClick={() => setAba(k)}>{n}</button>
        ))}
      </div>
      {aba === 'notas' && <AbaNotas inicioDevolucao={estado.devolucao} />}
      {aba === 'config' && <AbaConfig />}
      {aba === 'produtos' && <AbaProdutos />}
      {aba === 'perfis' && <AbaPerfis />}
      {!aba && <Vazio>O seu perfil não tem acesso a esta área.</Vazio>}
    </div>
  );
}

// ---------- notas emitidas ----------
const docNome = (n) => (n.modelo === 55 ? 'NF-e' : 'NFC-e');
const cpfFmt = (c) => String(c || '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');

async function baixar(rota, nome, toast, abrir = false) {
  try {
    const res = await fetch(`/api${rota}`, { headers: { Authorization: `Bearer ${localStorage.getItem('girostock_token')}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).erro || 'arquivo não encontrado');
    const url = URL.createObjectURL(await res.blob());
    if (abrir) window.open(url, '_blank', 'noopener');
    else {
      const a = document.createElement('a');
      a.href = url;
      a.download = nome;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) { toast.erro(err); }
}

function AbaNotas({ inicioDevolucao }) {
  const toast = useToast();
  const { user } = useAuth();
  const podeCancelar = podeAcessar(user, 'CancelarVendas');
  const [lista, setLista] = useState(null);
  const [situacao, setSituacao] = useState('');
  const [ambiente, setAmbiente] = useState('');
  const [soDevolucao, setSoDevolucao] = useState(!!inicioDevolucao);
  const [qtdDevolucao, setQtdDevolucao] = useState(0);
  const [cancelando, setCancelando] = useState(null);
  const [devolvendo, setDevolvendo] = useState(null);
  const [ocupado, setOcupado] = useState(null);
  const carregar = useCallback(async () => {
    const q = new URLSearchParams();
    if (soDevolucao) q.set('pendencia', 'devolucao');
    else {
      if (situacao) q.set('situacao', situacao);
      if (ambiente) q.set('ambiente', ambiente);
    }
    try {
      const [l, p] = await Promise.all([api.get(`/fiscal/notas?${q}`), api.get('/fiscal/notas?pendencia=devolucao')]);
      setLista(l);
      setQtdDevolucao(p.length);
    } catch (err) { toast.erro(err); }
  }, [situacao, ambiente, soDevolucao, toast]);
  useEffect(() => { carregar(); }, [carregar]);

  async function reenviar(n) {
    setOcupado(n.id);
    try {
      const r = await api.post(`/fiscal/notas/${n.id}/reenviar`, {});
      if (r.situacao === 'autorizada') toast.sucesso(`${docNome(r)} nº ${r.numero} autorizada`);
      else toast.erro(new Error(r.motivo || `Situação: ${NOME_SITUACAO[r.situacao]}`));
      await carregar();
    } catch (err) { toast.erro(err); } finally { setOcupado(null); }
  }

  const atencao = (lista || []).filter((n) => ['contingencia', 'rejeitada', 'erro'].includes(n.situacao)).length;
  return (
    <div className="card">
      {qtdDevolucao > 0 && !soDevolucao && (
        <div className="nf-alerta" role="alert">
          <b>{qtdDevolucao} nota(s) de vendas canceladas precisam de devolução.</b> A venda foi cancelada depois do prazo de cancelamento da nota na SEFAZ.
          <button type="button" className="btn-link" onClick={() => setSoDevolucao(true)}>Ver e gerar a devolução</button>
        </div>
      )}
      <div className="toolbar">
        <div className="ped-bar nf-filtro" role="tablist">
          <button type="button" role="tab" aria-selected={!soDevolucao} className={`btn-link ${!soDevolucao ? 'ativo' : ''}`} onClick={() => setSoDevolucao(false)}>Todas</button>
          <button type="button" role="tab" aria-selected={soDevolucao} className={`btn-link ${soDevolucao ? 'ativo' : ''}`} onClick={() => setSoDevolucao(true)}>Precisam de devolução{qtdDevolucao ? ` (${qtdDevolucao})` : ''}</button>
        </div>
        {!soDevolucao && (
          <>
            <select value={situacao} onChange={(e) => setSituacao(e.target.value)} aria-label="Situação">
              <option value="">Todas as situações</option>
              {Object.entries(NOME_SITUACAO).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
            </select>
            <select value={ambiente} onChange={(e) => setAmbiente(e.target.value)} aria-label="Ambiente">
              <option value="">Teste e produção</option>
              <option value="producao">Só produção (notas reais)</option>
              <option value="homologacao">Só teste</option>
            </select>
          </>
        )}
        <span className="toolbar-espaco" />
        <button type="button" className="btn-link" onClick={carregar}>Atualizar</button>
      </div>
      {soDevolucao && <p className="muted">Vendas canceladas cuja nota a SEFAZ não deixou cancelar (fora do prazo). Para regularizar, gere a NF-e de devolução: uma nota de entrada que devolve os itens e referencia a nota da venda. Confira com o seu contador.</p>}
      {!soDevolucao && atencao > 0 && <p className="muted">⚠ {atencao} nota(s) precisam de atenção: em contingência (o sistema envia sozinho quando a SEFAZ responder) ou rejeitadas (corrija o motivo e clique em “Reenviar”).</p>}
      {!lista ? <p className="muted">Carregando…</p> : lista.length === 0 ? (
        <Vazio>{soDevolucao ? 'Nenhuma nota pendente de devolução. ✔' : 'Nenhuma nota emitida ainda. No PDV, escolha “Cupom fiscal (NFC-e)” no pagamento.'}</Vazio>
      ) : (
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Nota</th><th>Venda</th><th>Valor</th><th>Situação</th><th className="col-opcional">Emitida</th><th /></tr></thead>
            <tbody>
              {lista.map((n) => (
                <tr key={n.id} className={n.pendencia ? 'nf-linha-pendente' : ''}>
                  <td>
                    <div className="celula-principal">{docNome(n)} nº {n.numero} <span className="muted">série {n.serie}</span>{n.teste && <span className="badge" style={{ marginLeft: 6 }}>TESTE</span>}</div>
                    {n.finalidade === 4 && <div className="celula-sub">Devolução da {n.ref_modelo === 55 ? 'NF-e' : 'NFC-e'} nº {n.ref_numero}{n.ref_venda_numero ? ` (venda nº ${n.ref_venda_numero})` : ''}</div>}
                    <div className="celula-sub">{n.location_nome}{n.cpf ? ` · CPF ${cpfFmt(n.cpf)}` : ''}</div>
                  </td>
                  <td>
                    {n.venda_numero ? `nº ${n.venda_numero}` : '—'}
                    {n.venda_status === 'cancelada' && <div className="celula-sub error">venda cancelada</div>}
                  </td>
                  <td>{brl(n.valor)}</td>
                  <td>
                    <span className={`ped-pill ${COR_SITUACAO[n.situacao] || ''}`}>{NOME_SITUACAO[n.situacao] || n.situacao}</span>
                    {n.pendencia === 'devolucao' && <div><span className="ped-pill warn nf-pill-devolucao">Precisa de devolução</span></div>}
                    {n.pendencia === 'devolucao' && n.pendencia_motivo && <div className="celula-sub">Não cancelada: {n.pendencia_motivo}</div>}
                    {n.devolucao_id && <div className="celula-sub">Devolução: NF-e nº {n.devolucao_numero} ({(NOME_SITUACAO[n.devolucao_situacao] || n.devolucao_situacao).toLowerCase()})</div>}
                    {n.motivo && !['autorizada', 'cancelada'].includes(n.situacao) && <div className="celula-sub">{n.motivo}</div>}
                    {n.situacao === 'cancelada' && n.cancel_justificativa && <div className="celula-sub">{n.cancel_justificativa}</div>}
                  </td>
                  <td className="col-opcional">{dataHora(n.emitida_em)}</td>
                  <td>
                    <div className="row-actions">
                      {n.pendencia === 'devolucao' && !n.devolucao_id && podeCancelar && <button type="button" className="btn-primario" onClick={() => setDevolvendo(n)}>Gerar devolução</button>}
                      {n.modelo === 55 && ['autorizada', 'cancelada'].includes(n.situacao) && <button type="button" className="btn-link" onClick={() => baixar(`/fiscal/notas/${n.id}/danfe`, `${n.chave}-nfe.pdf`, toast, true)}>DANFE (PDF)</button>}
                      {n.chave && <button type="button" className="btn-link" onClick={() => baixar(`/fiscal/notas/${n.id}/xml`, `${n.chave}-${n.modelo === 55 ? 'nfe' : 'nfce'}.xml`, toast)}>XML</button>}
                      {['contingencia', 'rejeitada', 'erro'].includes(n.situacao) && (
                        <button type="button" className="btn-link" disabled={ocupado === n.id} onClick={() => reenviar(n)}>{ocupado === n.id ? 'Enviando…' : n.situacao === 'contingencia' ? 'Enviar agora' : 'Reenviar'}</button>
                      )}
                      {n.situacao === 'autorizada' && podeCancelar && n.venda_status !== 'cancelada' && <button type="button" className="btn-link perigo" onClick={() => setCancelando(n)}>Cancelar nota</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cancelando && <CancelarNota nota={cancelando} onClose={() => setCancelando(null)} onFeito={() => { setCancelando(null); carregar(); }} />}
      {devolvendo && <FormDevolucao nota={devolvendo} onClose={() => setDevolvendo(null)} onFeito={() => { setDevolvendo(null); carregar(); }} />}
    </div>
  );
}

// NF-e de devolucao: quem devolveu (nome, CPF/CNPJ e endereco sao obrigatorios na NF-e).
function FormDevolucao({ nota, onClose, onFeito }) {
  const toast = useToast();
  const [d, setD] = useState({ nome: '', doc: nota.cpf ? cpfFmt(nota.cpf) : '', logradouro: '', numero: '', complemento: '', bairro: '', municipio: 'Curitiba', cod_municipio: '4106902', uf: 'PR', cep: '' });
  const [obs, setObs] = useState('');
  const [enviando, setEnviando] = useState(false);
  const set = (k) => (e) => setD((x) => ({ ...x, [k]: e.target.value }));
  async function enviar(e) {
    e.preventDefault();
    const doc = d.doc.replace(/\D/g, '');
    setEnviando(true);
    try {
      const r = await api.post(`/fiscal/notas/${nota.id}/devolucao`, { destinatario: { ...d, cpf: doc.length === 11 ? doc : '', cnpj: doc.length === 14 ? doc : '' }, observacao: obs });
      if (r.situacao === 'autorizada') toast.sucesso(`NF-e de devolução nº ${r.numero} autorizada`);
      else toast.erro(new Error(`NF-e de devolução nº ${r.numero}: ${r.motivo || NOME_SITUACAO[r.situacao]}. Corrija e clique em “Reenviar” na lista.`));
      onFeito();
    } catch (err) { toast.erro(err); } finally { setEnviando(false); }
  }
  return (
    <Modal titulo={`Devolução da ${docNome(nota)} nº ${nota.numero}`} subtitulo={`${brl(nota.valor)} · venda nº ${nota.venda_numero || '—'}${nota.teste ? ' · TESTE' : ''}`} onClose={onClose} largura="larga">
      <form className="form-stack" onSubmit={enviar}>
        <p className="muted">Sai uma NF-e de entrada (devolução de venda) com os mesmos itens e valores da nota, referenciando a chave dela. A NF-e exige os dados de quem devolveu.</p>
        <div className="nf-grade">
          <Field label="Nome de quem devolveu" className="nf-largo"><input autoFocus value={d.nome} onChange={set('nome')} required /></Field>
          <Field label="CPF ou CNPJ"><input value={d.doc} onChange={set('doc')} inputMode="numeric" required /></Field>
          <Field label="Rua" className="nf-largo"><input value={d.logradouro} onChange={set('logradouro')} required /></Field>
          <Field label="Número"><input value={d.numero} onChange={set('numero')} required /></Field>
          <Field label="Complemento"><input value={d.complemento} onChange={set('complemento')} /></Field>
          <Field label="Bairro"><input value={d.bairro} onChange={set('bairro')} required /></Field>
          <Field label="Cidade"><input value={d.municipio} onChange={set('municipio')} required /></Field>
          <Field label="Código IBGE da cidade" hint="Curitiba = 4106902"><input value={d.cod_municipio} onChange={set('cod_municipio')} inputMode="numeric" maxLength={7} required /></Field>
          <Field label="UF"><input value={d.uf} onChange={(e) => setD((x) => ({ ...x, uf: e.target.value.toUpperCase() }))} maxLength={2} required /></Field>
          <Field label="CEP"><input value={d.cep} onChange={set('cep')} inputMode="numeric" required /></Field>
        </div>
        <Field label="Observação (opcional)"><input value={obs} onChange={(e) => setObs(e.target.value)} maxLength={500} placeholder="Ex.: produto devolvido pelo cliente na loja" /></Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Voltar</button>
          <button type="submit" className="btn-primario" disabled={enviando}>{enviando ? 'Enviando à SEFAZ…' : 'Gerar NF-e de devolução'}</button>
        </div>
      </form>
    </Modal>
  );
}

function CancelarNota({ nota, onClose, onFeito }) {
  const toast = useToast();
  const [just, setJust] = useState('');
  const [enviando, setEnviando] = useState(false);
  async function enviar(e) {
    e.preventDefault();
    setEnviando(true);
    try {
      await api.post(`/fiscal/notas/${nota.id}/cancelar`, { justificativa: just });
      toast.sucesso(`${docNome(nota)} nº ${nota.numero} cancelada`);
      onFeito();
    } catch (err) { toast.erro(err); } finally { setEnviando(false); }
  }
  return (
    <Modal titulo={`Cancelar a ${docNome(nota)} nº ${nota.numero}`} subtitulo={`${brl(nota.valor)}${nota.venda_numero ? ` · venda nº ${nota.venda_numero}` : ''}`} onClose={onClose}>
      <form className="form-stack" onSubmit={enviar}>
        {nota.finalidade === 4
          ? <p className="muted">A NF-e pode ser cancelada em até 24 horas depois da autorização. Cancelando a devolução, a nota da venda volta para a lista “Precisam de devolução”.</p>
          : <p className="muted">A SEFAZ aceita o cancelamento da NFC-e em até 30 minutos depois da autorização (no Paraná). Depois disso, o caminho é a NF-e de devolução. Aqui cancela só a nota (ex.: CPF errado; depois dá para emitir de novo). Para desfazer a venda inteira, cancele a venda em Relatórios → Vendas: a nota é cancelada junto (ou vai para a lista de devolução, se o prazo passou).</p>}
        <Field label="Motivo do cancelamento (mínimo 15 letras)">
          <input autoFocus value={just} onChange={(e) => setJust(e.target.value)} placeholder="Ex.: cliente desistiu da compra no caixa" maxLength={255} required />
        </Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Voltar</button>
          <button type="submit" className="perigo" disabled={enviando || just.trim().length < 15}>{enviando ? 'Cancelando…' : 'Cancelar nota'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- configuracao da loja ----------
function AbaConfig() {
  const toast = useToast();
  const [dados, setDados] = useState(null);
  const [editando, setEditando] = useState(null);
  const [certDe, setCertDe] = useState(null);
  const [testando, setTestando] = useState(null);
  const carregar = useCallback(async () => {
    try { setDados(await api.get('/fiscal/lojas')); } catch (err) { toast.erro(err); }
  }, [toast]);
  useEffect(() => { carregar(); }, [carregar]);

  async function testar(l) {
    setTestando(l.location_id);
    try {
      const r = await api.post(`/fiscal/lojas/${l.location_id}/testar`, {});
      if (r.ok) toast.sucesso(`SEFAZ respondeu: ${r.motivo || 'serviço em operação'}`);
      else toast.erro(new Error(`SEFAZ: ${r.motivo || 'sem resposta'}`));
    } catch (err) { toast.erro(err); } finally { setTestando(null); }
  }

  if (!dados) return <p className="muted">Carregando…</p>;
  return (
    <>
      {dados.simulador && <p className="muted">Servidor de testes: as notas são montadas e assinadas de verdade, mas não são enviadas à SEFAZ (resposta simulada).</p>}
      {dados.lojas.map((l) => (
        <div key={l.location_id} className="card nf-loja">
          <div className="nf-loja-topo">
            <div>
              <h3>{l.location_nome}</h3>
              {l.configurada ? (
                <div className="celula-sub">{l.razao_social} · CNPJ {cnpjFmt(l.cnpj)} · IE {l.ie} · série {l.serie_nfce}</div>
              ) : <div className="celula-sub">Nota fiscal ainda não configurada.</div>}
            </div>
            {l.configurada && (
              <div className="nf-selos">
                <span className={`ped-pill ${l.ambiente === 'producao' ? 'ok' : 'warn'}`}>{l.ambiente === 'producao' ? 'Produção (notas reais)' : 'Teste (homologação)'}</span>
                <span className={`ped-pill ${l.pronta ? 'ok' : 'err'}`}>{l.pronta ? 'Pronta para emitir' : 'Falta configurar'}</span>
              </div>
            )}
          </div>
          {l.configurada && (
            <ul className="nf-resumo">
              <li>No PDV: <b>{{ desligado: 'não emite (só cupom)', perguntar: 'o caixa escolhe “cupom fiscal” ou “só cupom”', sempre: 'sempre cupom fiscal' }[l.modo_pdv]}</b></li>
              <li>Certificado A1: {l.certificado ? <b>{l.certificado.titular} · vence em {String(l.certificado.validade).slice(0, 10).split('-').reverse().join('/')}</b> : <span className="error">não enviado</span>}</li>
              <li>CSC de teste: {l.csc_homologacao ? <b>informado (ID {l.csc_homolog_id})</b> : <span className="muted">não informado</span>} · CSC de produção: {l.csc_producao ? <b>informado (ID {l.csc_prod_id})</b> : <span className="muted">não informado</span>}</li>
            </ul>
          )}
          {l.pendencias && l.pendencias.length > 0 && <p className="error">Falta: {l.pendencias.join('; ')}.</p>}
          <div className="row-actions">
            <button type="button" className="btn-primario" onClick={() => setEditando(l)}>{l.configurada ? 'Editar dados fiscais' : 'Configurar nota fiscal'}</button>
            {l.configurada && <button type="button" onClick={() => setCertDe(l)}>{l.certificado ? 'Trocar certificado' : 'Enviar certificado A1'}</button>}
            {l.certificado && <button type="button" className="btn-link" disabled={testando === l.location_id} onClick={() => testar(l)}>{testando === l.location_id ? 'Testando…' : 'Testar conexão com a SEFAZ'}</button>}
          </div>
        </div>
      ))}
      <div className="card">
        <h3>Como começar</h3>
        <ol className="nf-passos">
          <li>Preencha os dados fiscais da loja (iguais ao cartão CNPJ e à inscrição estadual).</li>
          <li>Envie o certificado digital A1 (arquivo .pfx ou .p12) e a senha dele.</li>
          <li>Gere o CSC (código de segurança do contribuinte) no site da Receita Estadual (no Paraná: Receita/PR → NFC-e → CSC). Há um CSC para teste e outro para produção.</li>
          <li>Deixe em <b>Teste (homologação)</b> e faça algumas vendas com “Cupom fiscal”: as notas saem “sem valor fiscal”.</li>
          <li>Com tudo certo, mude para <b>Produção</b> e informe o CSC de produção. A partir daí as notas são reais.</li>
        </ol>
        <p className="muted">Antes de vender em produção, cadastre o NCM e o perfil fiscal dos produtos (abas “Produtos (NCM)” e “Perfis fiscais”), conferidos com o seu contador.</p>
      </div>
      {editando && <FormConfig loja={editando} onClose={() => setEditando(null)} onSalvo={() => { setEditando(null); carregar(); }} />}
      {certDe && <FormCertificado loja={certDe} onClose={() => setCertDe(null)} onSalvo={() => { setCertDe(null); carregar(); }} />}
    </>
  );
}

const VAZIO_CFG = { ambiente: 'homologacao', modo_pdv: 'perguntar', crt: 1, uf: 'PR', serie_nfce: 1, cnpj: '', ie: '', razao_social: '', nome_fantasia: '', logradouro: '', numero: '', complemento: '', bairro: '', cod_municipio: '4106902', municipio: 'Curitiba', cep: '', telefone: '' };

function FormConfig({ loja, onClose, onSalvo }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [f, setF] = useState(() => ({ ...VAZIO_CFG, ...(loja.configurada ? Object.fromEntries(Object.entries(loja).filter(([, v]) => v !== null && v !== undefined)) : {}), csc_homologacao: '', csc_producao: '' }));
  const [salvando, setSalvando] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const indoParaProducao = f.ambiente === 'producao' && loja.ambiente !== 'producao';

  async function salvar(e) {
    e.preventDefault();
    const corpo = { ...f };
    if (!corpo.csc_homologacao) delete corpo.csc_homologacao;
    if (!corpo.csc_producao) delete corpo.csc_producao;
    if (indoParaProducao && loja.configurada) {
      const ok = await confirmar({ titulo: 'Passar a emitir notas reais?', mensagem: 'Em produção, cada NFC-e tem valor fiscal e é informada à Receita. Faça isso só depois de testar e de conferir o NCM e a tributação com o seu contador.', confirmar: 'Sim, emitir em produção' });
      if (!ok) return;
      corpo.confirmar_producao = true;
    }
    setSalvando(true);
    try {
      await api.put(`/fiscal/lojas/${loja.location_id}`, corpo);
      toast.sucesso('Dados fiscais salvos');
      onSalvo();
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }

  return (
    <Modal titulo={`Nota fiscal · ${loja.location_nome}`} largura="larga" onClose={onClose}>
      <form className="form-stack" onSubmit={salvar}>
        <div className="nf-grade">
          <Field label="Ambiente">
            <select value={f.ambiente} onChange={set('ambiente')}>
              <option value="homologacao">Teste (homologação): notas sem valor fiscal</option>
              <option value="producao">Produção: notas reais</option>
            </select>
          </Field>
          <Field label="No PDV">
            <select value={f.modo_pdv} onChange={set('modo_pdv')}>
              <option value="perguntar">O caixa escolhe: cupom fiscal ou só cupom</option>
              <option value="sempre">Sempre cupom fiscal</option>
              <option value="desligado">Desligado (só cupom não fiscal)</option>
            </select>
          </Field>
          <Field label="CNPJ"><input value={f.cnpj} onChange={set('cnpj')} inputMode="numeric" required /></Field>
          <Field label="Inscrição estadual"><input value={f.ie} onChange={set('ie')} inputMode="numeric" required /></Field>
          <Field label="Razão social" className="nf-largo"><input value={f.razao_social} onChange={set('razao_social')} maxLength={60} required /></Field>
          <Field label="Nome fantasia"><input value={f.nome_fantasia} onChange={set('nome_fantasia')} maxLength={60} /></Field>
          <Field label="Regime tributário">
            <select value={f.crt} onChange={(e) => setF((x) => ({ ...x, crt: Number(e.target.value) }))}>
              <option value={1}>Simples Nacional</option>
              <option value={4}>MEI</option>
              <option value={2}>Simples Nacional · excesso de sublimite</option>
              <option value={3}>Regime normal (Lucro Presumido/Real)</option>
            </select>
          </Field>
          <Field label="Rua" className="nf-largo"><input value={f.logradouro} onChange={set('logradouro')} required /></Field>
          <Field label="Número"><input value={f.numero} onChange={set('numero')} required /></Field>
          <Field label="Complemento"><input value={f.complemento} onChange={set('complemento')} /></Field>
          <Field label="Bairro"><input value={f.bairro} onChange={set('bairro')} required /></Field>
          <Field label="Cidade"><input value={f.municipio} onChange={set('municipio')} required /></Field>
          <Field label="Código IBGE da cidade" hint="Curitiba = 4106902"><input value={f.cod_municipio} onChange={set('cod_municipio')} inputMode="numeric" maxLength={7} required /></Field>
          <Field label="UF"><input value={f.uf} onChange={(e) => setF((x) => ({ ...x, uf: e.target.value.toUpperCase() }))} maxLength={2} required /></Field>
          <Field label="CEP"><input value={f.cep} onChange={set('cep')} inputMode="numeric" required /></Field>
          <Field label="Telefone"><input value={f.telefone} onChange={set('telefone')} /></Field>
          <Field label="Série da NFC-e" hint="Normalmente 1"><input type="number" min={0} max={999} value={f.serie_nfce} onChange={(e) => setF((x) => ({ ...x, serie_nfce: Number(e.target.value) }))} /></Field>
          <Field label="Série da NF-e (devoluções)" hint="Normalmente 1"><input type="number" min={0} max={999} value={f.serie_nfe ?? 1} onChange={(e) => setF((x) => ({ ...x, serie_nfe: Number(e.target.value) }))} /></Field>
        </div>
        <h4>CSC (código de segurança do contribuinte)</h4>
        <p className="muted">Gerado no site da Receita Estadual. Por segurança, o código salvo não aparece aqui: preencha só para trocar.</p>
        <div className="nf-grade">
          <Field label={`CSC de teste ${loja.csc_homologacao ? '(já informado)' : ''}`}><input value={f.csc_homologacao} onChange={set('csc_homologacao')} autoComplete="off" placeholder={loja.csc_homologacao ? '••••••••' : ''} /></Field>
          <Field label="ID do CSC de teste"><input value={f.csc_homolog_id || ''} onChange={set('csc_homolog_id')} inputMode="numeric" placeholder="1" /></Field>
          <Field label={`CSC de produção ${loja.csc_producao ? '(já informado)' : ''}`}><input value={f.csc_producao} onChange={set('csc_producao')} autoComplete="off" placeholder={loja.csc_producao ? '••••••••' : ''} /></Field>
          <Field label="ID do CSC de produção"><input value={f.csc_prod_id || ''} onChange={set('csc_prod_id')} inputMode="numeric" placeholder="1" /></Field>
        </div>
        {indoParaProducao && <p className="error">Atenção: em produção as notas são reais. Confira com o contador antes.</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-primario" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </form>
    </Modal>
  );
}

function FormCertificado({ loja, onClose, onSalvo }) {
  const toast = useToast();
  const [arquivo, setArquivo] = useState(null);
  const [senha, setSenha] = useState('');
  const [enviando, setEnviando] = useState(false);
  async function enviar(e) {
    e.preventDefault();
    if (!arquivo) return;
    if (arquivo.size > 150000) { toast.erro(new Error('arquivo grande demais para um certificado A1')); return; }
    setEnviando(true);
    try {
      const b64 = await new Promise((ok, falha) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1] || '');
        r.onerror = () => falha(new Error('não foi possível ler o arquivo'));
        r.readAsDataURL(arquivo);
      });
      const r = await api.post(`/fiscal/lojas/${loja.location_id}/certificado`, { pfx_b64: b64, senha });
      toast.sucesso(`Certificado de ${r.titular} salvo (vence em ${String(r.validade).split('-').reverse().join('/')})`);
      onSalvo();
    } catch (err) { toast.erro(err); } finally { setEnviando(false); }
  }
  return (
    <Modal titulo="Certificado digital A1" subtitulo={loja.location_nome} onClose={onClose}>
      <form className="form-stack" onSubmit={enviar}>
        <p className="muted">O certificado A1 é o arquivo .pfx (ou .p12) que a certificadora entrega. Ele fica guardado cifrado e só é usado para assinar as notas desta loja.</p>
        <Field label="Arquivo do certificado"><input type="file" accept=".pfx,.p12,application/x-pkcs12" onChange={(e) => setArquivo(e.target.files[0] || null)} required /></Field>
        <Field label="Senha do certificado"><input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="new-password" required /></Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-primario" disabled={enviando || !arquivo}>{enviando ? 'Conferindo…' : 'Enviar certificado'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- produtos (NCM, CEST e perfil) ----------
function AbaProdutos() {
  const toast = useToast();
  const [lista, setLista] = useState(null);
  const [perfis, setPerfis] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [busca, setBusca] = useState('');
  const [pendentes, setPendentes] = useState(true);
  const [editando, setEditando] = useState({}); // id -> { ncm, cest, perfil_fiscal_id }
  const [marcados, setMarcados] = useState([]);
  const [perfilLote, setPerfilLote] = useState('');
  const carregar = useCallback(async () => {
    const q = new URLSearchParams();
    if (busca.trim()) q.set('busca', busca.trim());
    if (pendentes) q.set('pendentes', '1');
    try { setLista(await api.get(`/fiscal/produtos?${q}`)); } catch (err) { toast.erro(err); }
  }, [busca, pendentes, toast]);
  useEffect(() => { const t = setTimeout(carregar, 250); return () => clearTimeout(t); }, [carregar]);
  const carregarAux = useCallback(() => {
    api.get('/fiscal/perfis').then(setPerfis).catch(() => {});
    api.get('/fiscal/categorias').then(setCategorias).catch(() => {});
  }, []);
  useEffect(() => { carregarAux(); }, [carregarAux]);

  const valor = (p, k) => (editando[p.id] && editando[p.id][k] !== undefined ? editando[p.id][k] : p[k] || '');
  const mudar = (p, k, v) => setEditando((x) => ({ ...x, [p.id]: { ...(x[p.id] || {}), [k]: v } }));
  async function salvar(p) {
    try {
      await api.put(`/fiscal/produtos/${p.id}`, { ncm: valor(p, 'ncm'), cest: valor(p, 'cest'), perfil_fiscal_id: valor(p, 'perfil_fiscal_id') || null });
      setEditando((x) => { const y = { ...x }; delete y[p.id]; return y; });
      toast.sucesso(`${p.nome}: salvo`);
      carregar();
    } catch (err) { toast.erro(err); }
  }
  async function aplicarLote() {
    try {
      const r = await api.post('/fiscal/produtos/lote', { ids: marcados, perfil_fiscal_id: perfilLote || null });
      toast.sucesso(`${r.atualizados} produto(s) atualizados`);
      setMarcados([]);
      carregar();
    } catch (err) { toast.erro(err); }
  }
  async function perfilDaCategoria(c, perfilId) {
    try {
      await api.put(`/fiscal/categorias/${c.id}`, { perfil_fiscal_id: perfilId || null });
      toast.sucesso(`Categoria ${c.nome}: perfil salvo`);
      carregarAux();
      carregar();
    } catch (err) { toast.erro(err); }
  }

  return (
    <>
      <div className="card">
        <p className="muted">Toda nota precisa do <b>NCM</b> de cada produto (8 números, está na nota de compra do fornecedor) e de um <b>perfil fiscal</b>. O perfil vem do produto, senão da categoria, senão do perfil padrão. Ao importar o XML de uma nota de compra, o NCM dos produtos é preenchido sozinho.</p>
        <div className="toolbar">
          <input className="toolbar-busca" placeholder="Buscar produto, código ou código de barras" value={busca} onChange={(e) => setBusca(e.target.value)} />
          <label className="check"><input type="checkbox" checked={pendentes} onChange={(e) => setPendentes(e.target.checked)} /> Só os que faltam dados</label>
        </div>
        {marcados.length > 0 && (
          <div className="toolbar">
            <span>{marcados.length} marcado(s): perfil</span>
            <select value={perfilLote} onChange={(e) => setPerfilLote(e.target.value)}>
              <option value="">(usar o da categoria/padrão)</option>
              {perfis.map((pf) => <option key={pf.id} value={pf.id}>{pf.nome}</option>)}
            </select>
            <button type="button" className="btn-primario" onClick={aplicarLote}>Aplicar</button>
            <button type="button" className="btn-link" onClick={() => setMarcados([])}>Desmarcar</button>
          </div>
        )}
        {!lista ? <p className="muted">Carregando…</p> : lista.length === 0 ? <Vazio>{pendentes ? 'Todos os produtos têm NCM e perfil fiscal. ✔' : 'Nenhum produto encontrado.'}</Vazio> : (
          <div className="tabela-wrap">
            <table className="tabela-cartoes nf-produtos">
              <thead><tr><th><input type="checkbox" aria-label="Marcar todos" checked={marcados.length === lista.length} onChange={(e) => setMarcados(e.target.checked ? lista.map((p) => p.id) : [])} /></th><th>Produto</th><th>NCM</th><th>CEST</th><th>Perfil fiscal</th><th /></tr></thead>
              <tbody>
                {lista.map((p) => (
                  <tr key={p.id}>
                    <td><input type="checkbox" aria-label={`Marcar ${p.nome}`} checked={marcados.includes(p.id)} onChange={(e) => setMarcados((m) => (e.target.checked ? [...m, p.id] : m.filter((x) => x !== p.id)))} /></td>
                    <td><div className="celula-principal">{p.nome}</div><div className="celula-sub">{[p.codigo_interno, p.barcode, p.categoria_nome].filter(Boolean).join(' · ')}</div></td>
                    <td><input className={`nf-ncm ${!valor(p, 'ncm') ? 'nf-falta' : ''}`} inputMode="numeric" maxLength={8} placeholder="00000000" value={valor(p, 'ncm')} onChange={(e) => mudar(p, 'ncm', e.target.value.replace(/\D/g, ''))} aria-label={`NCM de ${p.nome}`} /></td>
                    <td><input className="nf-cest" inputMode="numeric" maxLength={7} value={valor(p, 'cest')} onChange={(e) => mudar(p, 'cest', e.target.value.replace(/\D/g, ''))} aria-label={`CEST de ${p.nome}`} /></td>
                    <td>
                      <select value={valor(p, 'perfil_fiscal_id')} onChange={(e) => mudar(p, 'perfil_fiscal_id', e.target.value)} aria-label={`Perfil fiscal de ${p.nome}`}>
                        <option value="">{p.perfil_origem && p.perfil_origem !== 'produto' ? `${p.perfil_efetivo} · ${p.perfil_origem === 'categoria' ? 'da categoria' : 'padrão'}` : '(da categoria ou padrão)'}</option>
                        {perfis.map((pf) => <option key={pf.id} value={pf.id}>{pf.nome}</option>)}
                      </select>
                      {!p.perfil_efetivo && !valor(p, 'perfil_fiscal_id') && <div className="celula-sub error">sem perfil</div>}
                    </td>
                    <td>{editando[p.id] && <button type="button" className="btn-primario" onClick={() => salvar(p)}>Salvar</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h3>Perfil fiscal por categoria</h3>
        <p className="muted">Mais rápido: defina o perfil da categoria (ex.: Bebidas = “Bebida com ST”) e todos os produtos dela usam esse perfil, a não ser que o produto tenha um próprio.</p>
        {categorias.length === 0 ? <Vazio>Nenhuma categoria.</Vazio> : (
          <div className="tabela-wrap">
            <table className="tabela-cartoes compacta">
              <tbody>
                {categorias.map((c) => (
                  <tr key={c.id}>
                    <td><div className="celula-principal">{c.nome}</div><div className="celula-sub">{c.produtos} produto(s)</div></td>
                    <td>
                      <select value={c.perfil_fiscal_id || ''} onChange={(e) => perfilDaCategoria(c, e.target.value)} aria-label={`Perfil fiscal da categoria ${c.nome}`}>
                        <option value="">(perfil padrão)</option>
                        {perfis.map((pf) => <option key={pf.id} value={pf.id}>{pf.nome}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---------- perfis fiscais ----------
function AbaPerfis() {
  const toast = useToast();
  const confirmar = useConfirm();
  const [lista, setLista] = useState(null);
  const [form, setForm] = useState(null);
  const carregar = useCallback(async () => {
    try { setLista(await api.get('/fiscal/perfis')); } catch (err) { toast.erro(err); }
  }, [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  async function excluir(p) {
    if (!(await confirmar({ titulo: `Excluir o perfil "${p.nome}"?`, confirmar: 'Excluir' }))) return;
    try { await api.del(`/fiscal/perfis/${p.id}`); carregar(); } catch (err) { toast.erro(err); }
  }
  async function modelos() {
    const base = [
      { nome: 'Mercadoria em geral', cfop: '5102', csosn: '102', padrao: true },
      { nome: 'Bebida / cigarro com ST', cfop: '5405', csosn: '500' },
    ];
    try {
      for (const m of base) await api.post('/fiscal/perfis', m);
      toast.sucesso('Perfis de exemplo criados: confira com o seu contador');
      carregar();
    } catch (err) { toast.erro(err); }
  }
  return (
    <div className="card">
      <div className="toolbar">
        <p className="muted" style={{ margin: 0, flex: 1 }}>O perfil fiscal guarda a tributação que o contador define (CFOP, CSOSN, origem e PIS/COFINS). Você cria poucos perfis e liga cada produto ou categoria a um deles.</p>
        <button type="button" className="btn-primario" onClick={() => setForm({})}>+ Novo perfil</button>
      </div>
      {!lista ? <p className="muted">Carregando…</p> : lista.length === 0 ? (
        <Vazio>
          Nenhum perfil ainda. <button type="button" className="btn-link" onClick={modelos}>Criar os perfis mais comuns do Simples Nacional</button> (mercadoria em geral e bebida/cigarro com ST).
        </Vazio>
      ) : (
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Perfil</th><th>CFOP</th><th>CSOSN</th><th className="col-opcional">Uso</th><th /></tr></thead>
            <tbody>
              {lista.map((p) => (
                <tr key={p.id}>
                  <td><div className="celula-principal">{p.nome}{p.padrao && <span className="badge" style={{ marginLeft: 6 }}>padrão</span>}</div><div className="celula-sub">Origem {p.origem} · PIS {p.cst_pis} · COFINS {p.cst_cofins}</div></td>
                  <td>{p.cfop}</td>
                  <td>{p.csosn}</td>
                  <td className="col-opcional">{p.produtos} produto(s) · {p.categorias} categoria(s)</td>
                  <td><div className="row-actions"><button type="button" className="btn-link" onClick={() => setForm(p)}>Editar</button><button type="button" className="btn-link perigo" onClick={() => excluir(p)}>Excluir</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && <FormPerfil perfil={form} onClose={() => setForm(null)} onSalvo={() => { setForm(null); carregar(); }} />}
    </div>
  );
}

function FormPerfil({ perfil, onClose, onSalvo }) {
  const toast = useToast();
  const [f, setF] = useState({ nome: '', cfop: '5102', csosn: '102', origem: 0, cst_pis: '49', cst_cofins: '49', padrao: false, ...perfil });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function salvar(e) {
    e.preventDefault();
    try {
      if (perfil.id) await api.put(`/fiscal/perfis/${perfil.id}`, f);
      else await api.post('/fiscal/perfis', f);
      onSalvo();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo={perfil.id ? `Perfil: ${perfil.nome}` : 'Novo perfil fiscal'} onClose={onClose}>
      <form className="form-stack" onSubmit={salvar}>
        <Field label="Nome"><input autoFocus value={f.nome} onChange={set('nome')} placeholder="Ex.: Bebida com ST" required /></Field>
        <Field label="CFOP" hint="5102 = venda de mercadoria · 5405 = mercadoria com ST já recolhida"><input value={f.cfop} onChange={set('cfop')} inputMode="numeric" maxLength={4} required /></Field>
        <Field label="CSOSN (Simples Nacional)">
          <select value={f.csosn} onChange={set('csosn')}>{Object.entries(CSOSN).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
        </Field>
        <Field label="Origem da mercadoria">
          <select value={f.origem} onChange={(e) => setF((x) => ({ ...x, origem: Number(e.target.value) }))}>{Object.entries(ORIGEM).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
        </Field>
        <div className="form-grid">
          <Field label="CST PIS" hint="Simples: 49"><input value={f.cst_pis} onChange={set('cst_pis')} maxLength={2} /></Field>
          <Field label="CST COFINS" hint="Simples: 49"><input value={f.cst_cofins} onChange={set('cst_cofins')} maxLength={2} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={!!f.padrao} onChange={(e) => setF((x) => ({ ...x, padrao: e.target.checked }))} /> Perfil padrão (para produtos sem perfil no produto nem na categoria)</label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-primario">Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

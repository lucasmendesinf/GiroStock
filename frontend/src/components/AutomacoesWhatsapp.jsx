import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Field } from './ui.jsx';

// Campanhas automaticas: todo dia, no horario escolhido, o sistema manda o cupom para quem sumiu ha X dias e para o
// aniversariante do dia. Mesmas regras das campanhas (consentimento, 7 dias entre campanhas, cupom individual).
const INFO = {
  sumido: { titulo: 'Cliente sumido', texto: 'Quem completou os dias sem pedir recebe "Volte com cupom" (uma vez a cada sumiço).' },
  aniversario: { titulo: 'Aniversariante do dia', texto: 'Quem faz aniversário hoje (do cadastro do cliente) recebe "Aniversário com cupom" (uma vez por ano).' },
};
const dataBR = (d) => (d ? d.split('-').reverse().join('/') : '');

export default function AutomacoesWhatsapp() {
  const toast = useToast();
  const [lista, setLista] = useState(null);
  const carregar = useCallback(() => api.get('/whatsapp/automacoes').then(setLista).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  if (!lista) return null;
  return (
    <div className="wa-auto">
      <h4 style={{ margin: '4px 0 6px' }}>Automáticas (todo dia)</h4>
      <div className="wa-auto-grid">
        {lista.map((a) => <Automacao key={a.tipo} a={a} onMudou={setLista} />)}
      </div>
    </div>
  );
}

function Automacao({ a, onMudou }) {
  const toast = useToast();
  const [f, setF] = useState({ dias: String(a.dias), hora: String(a.hora), cupom_tipo: a.cupom_tipo, cupom_valor: String(a.cupom_valor).replace('.', ','), cupom_validade_dias: String(a.cupom_validade_dias), cupom_pedido_minimo: String(a.cupom_pedido_minimo).replace('.', ',') });
  const [ocupado, setOcupado] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const num = (v) => Number(String(v).replace(',', '.')) || 0;
  const corpo = (extra = {}) => ({ dias: Number(f.dias), hora: Number(f.hora), cupom_tipo: f.cupom_tipo, cupom_valor: num(f.cupom_valor), cupom_validade_dias: Number(f.cupom_validade_dias), cupom_pedido_minimo: num(f.cupom_pedido_minimo), ...extra });
  async function salvar(extra = {}) {
    setOcupado(true);
    try { onMudou(await api.put(`/whatsapp/automacoes/${a.tipo}`, corpo({ ativo: a.ativo, ...extra }))); toast.sucesso(extra.ativo === true ? 'Automação ligada' : extra.ativo === false ? 'Automação desligada' : 'Automação salva'); } catch (err) { toast.erro(err); } finally { setOcupado(false); }
  }
  async function rodar() {
    setOcupado(true);
    try {
      const r = await api.post(`/whatsapp/automacoes/${a.tipo}/rodar`, {});
      if (r.total) toast.sucesso(`${r.total} cliente(s) na fila de envio`); else toast.erro(new Error(r.motivo || 'ninguém para receber hoje'));
      onMudou(await api.get('/whatsapp/automacoes'));
    } catch (err) { toast.erro(err); } finally { setOcupado(false); }
  }
  return (
    <div className={`wa-auto-item ${a.ativo ? 'on' : ''}`}>
      <div className="toolbar" style={{ marginTop: 0 }}>
        <b style={{ flex: 1 }}>{INFO[a.tipo].titulo}</b>
        <label className="check"><input type="checkbox" checked={a.ativo} disabled={ocupado} onChange={(e) => salvar({ ativo: e.target.checked })} /> Ligada</label>
      </div>
      <p className="celula-sub" style={{ margin: '0 0 8px' }}>{INFO[a.tipo].texto}</p>
      <div className="form-grid">
        {a.tipo === 'sumido' && <Field label="Dias sem pedir"><input value={f.dias} onChange={set('dias')} inputMode="numeric" /></Field>}
        <Field label="Enviar a partir das (h)"><input value={f.hora} onChange={set('hora')} inputMode="numeric" /></Field>
        <Field label="Cupom">
          <select value={f.cupom_tipo} onChange={set('cupom_tipo')}><option value="percentual">% de desconto</option><option value="valor">R$ de desconto</option><option value="frete_gratis">Frete grátis</option></select>
        </Field>
        {f.cupom_tipo !== 'frete_gratis' && <Field label={f.cupom_tipo === 'percentual' ? 'Desconto (%)' : 'Desconto (R$)'}><input value={f.cupom_valor} onChange={set('cupom_valor')} inputMode="decimal" /></Field>}
        <Field label="Validade (dias)"><input value={f.cupom_validade_dias} onChange={set('cupom_validade_dias')} inputMode="numeric" /></Field>
        <Field label="Pedido mínimo (R$)"><input value={f.cupom_pedido_minimo} onChange={set('cupom_pedido_minimo')} inputMode="decimal" /></Field>
      </div>
      <div className="celula-sub" style={{ margin: '6px 0' }}>
        {a.ultimo_dia ? <>Última vez: {dataBR(a.ultimo_dia)} · {a.ultimo_total || 0} cliente(s){a.ultimo_motivo && a.ultimo_motivo !== 'rodando' ? ` · ${a.ultimo_motivo}` : ''}</> : 'Ainda não rodou.'}
        {' · '}{a.enviadas} enviada(s) no total · {a.cupons_usados} cupom(ns) usado(s)
      </div>
      <div className="row-actions">
        <button type="button" disabled={ocupado} onClick={() => salvar()}>Salvar</button>
        {a.ativo && <button type="button" className="btn-link" disabled={ocupado} onClick={rodar} title="Manda agora, sem esperar o horário (só para quem ainda não recebeu)">Enviar hoje agora</button>}
      </div>
    </div>
  );
}

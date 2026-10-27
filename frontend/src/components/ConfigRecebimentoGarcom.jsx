import { useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Field, Modal } from './ui.jsx';

// Recebimento pelo garcom (modulo "Garcom e comandas"), por loja: liga/desliga, formas liberadas, taxa de servico e o terminal
// (PDV) em que as comandas quitadas no app sao encerradas.
export default function ConfigRecebimentoGarcom({ loja, terminais, onClose, onSalvo }) {
  const toast = useToast();
  const f = loja.garcom_formas || {};
  const [recebe, setRecebe] = useState(!!loja.garcom_recebe);
  const [formas, setFormas] = useState({ pix: f.pix !== false, cartao: f.cartao !== false, dinheiro: f.dinheiro !== false });
  const [taxa, setTaxa] = useState(String(loja.taxa_servico_pct === undefined || loja.taxa_servico_pct === null ? 10 : Number(loja.taxa_servico_pct)).replace('.', ','));
  const [terminalId, setTerminalId] = useState(loja.terminal_comandas_id || '');
  const [salvando, setSalvando] = useState(false);
  const daLoja = terminais.filter((t) => t.location_id === loja.id && t.ativo);

  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      await api.put(`/locations/${loja.id}/recebimento-garcom`, { garcom_recebe: recebe, garcom_formas: formas, taxa_servico_pct: Number(String(taxa).replace(',', '.')), terminal_comandas_id: terminalId || null });
      toast.sucesso('Recebimento do garçom salvo.');
      onSalvo();
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  return (
    <Modal titulo="Recebimento do garçom" subtitulo={loja.nome} onClose={onClose}>
      <form onSubmit={salvar} className="form-stack">
        <label className="check"><input type="checkbox" checked={recebe} onChange={(e) => setRecebe(e.target.checked)} /> Garçom pode receber no app (precisa também da permissão “Receber pagamentos no app” em Usuários)</label>
        <Field label="Formas liberadas no app">
          <div className="permissoes-lista">
            <label className="permissao-item"><input type="checkbox" checked={formas.pix} onChange={(e) => setFormas({ ...formas, pix: e.target.checked })} /><span>Pix</span></label>
            <label className="permissao-item"><input type="checkbox" checked={formas.cartao} onChange={(e) => setFormas({ ...formas, cartao: e.target.checked })} /><span>Cartão (crédito e débito, na maquininha)</span></label>
            <label className="permissao-item"><input type="checkbox" checked={formas.dinheiro} onChange={(e) => setFormas({ ...formas, dinheiro: e.target.checked })} /><span>Dinheiro (fica com o garçom até a prestação de contas)</span></label>
          </div>
        </Field>
        <Field label="Taxa de serviço (%)" hint="Opcional em cada recebimento/fechamento. Padrão 10%."><input inputMode="decimal" value={taxa} onChange={(e) => setTaxa(e.target.value)} required /></Field>
        <Field label="PDV de comandas" hint="Onde a comanda toda paga no app vira venda. Sem escolher, usa um PDV da loja com o caixa aberto.">
          <select value={terminalId} onChange={(e) => setTerminalId(e.target.value)}>
            <option value="">Automático (PDV com caixa aberto)</option>
            {daLoja.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
          </select>
        </Field>
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button type="submit" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</button></div>
      </form>
    </Modal>
  );
}

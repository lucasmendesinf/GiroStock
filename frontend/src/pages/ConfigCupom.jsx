import { useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Field, Modal } from '../components/ui.jsx';
import { CupomCliente, ComandaCozinha, CONFIG_PADRAO } from '../components/Cupom.jsx';

// Venda de exemplo para a previa (nao grava nada).
function vendaExemplo(loja) {
  return {
    empresa_nome: 'Sua Empresa', location_nome: loja.nome, terminal_nome: 'PDV 01', operador_nome: 'Maria',
    numero: 1234, numero_pedido: loja.usa_comanda ? 27 : null, criado_em: new Date().toISOString(), status: 'concluida',
    subtotal: 38.9, desconto: 3.9, total: 35, forma_pagamento: 'dinheiro', valor_recebido: 50, troco: 15,
    itens: [
      { id: 1, product_nome: 'X-Tudo', codigo_interno: 'PRD-0005', quantidade: 2, unidade: 'UN', preco_unitario: 15.9, subtotal: 31.8, preparo: true, observacao: 'sem milho' },
      { id: 2, product_nome: 'Coca Cola 350ml', codigo_interno: 'PRD-0003', quantidade: 2, unidade: 'UN', preco_unitario: 3.55, subtotal: 7.1, preparo: false },
    ],
  };
}

function Opcao({ rotulo, valor, onChange }) {
  return (
    <label className="permissao-item"><input type="checkbox" checked={!!valor} onChange={(e) => onChange(e.target.checked)} /><span>{rotulo}</span></label>
  );
}

// Configuracao do cupom do cliente e da comanda da cozinha de uma loja, com previa ao vivo.
export default function ConfigCupom({ loja, onClose, onSalvo }) {
  const toast = useToast();
  const salvo = loja.cupom_config || {};
  const [cfg, setCfg] = useState({
    cliente: { ...CONFIG_PADRAO.cliente, ...(salvo.cliente || {}) },
    cozinha: { ...CONFIG_PADRAO.cozinha, ...(salvo.cozinha || {}) },
  });
  const [aba, setAba] = useState('cliente');
  const [salvando, setSalvando] = useState(false);
  const c = cfg.cliente;
  const k = cfg.cozinha;
  const setC = (campos) => setCfg({ ...cfg, cliente: { ...c, ...campos } });
  const setK = (campos) => setCfg({ ...cfg, cozinha: { ...k, ...campos } });

  async function salvar() {
    setSalvando(true);
    try {
      await api.patch(`/locations/${loja.id}`, { cupom_config: cfg });
      toast.sucesso('Configuração do cupom salva.');
      onSalvo();
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }

  const venda = vendaExemplo(loja);

  return (
    <Modal titulo={`Cupom e comanda — ${loja.nome}`} subtitulo="O que aparece no cupom do cliente e na comanda da cozinha desta loja" onClose={onClose} largura="xml">
      <div className="segmentado" style={{ marginBottom: 12 }}>
        <button type="button" className={aba === 'cliente' ? 'ativo' : ''} onClick={() => setAba('cliente')}>Cupom do cliente</button>
        <button type="button" className={aba === 'cozinha' ? 'ativo' : ''} onClick={() => setAba('cozinha')}>Comanda da cozinha</button>
      </div>

      <div className="config-cupom">
        <div className="form-stack">
          {aba === 'cliente' && (
            <>
              <Field label="Texto do cabeçalho" hint="Aparece abaixo do nome da loja. Use para CNPJ, endereço, telefone (uma informação por linha).">
                <textarea rows={3} maxLength={400} value={c.cabecalho} onChange={(e) => setC({ cabecalho: e.target.value })} placeholder={'CNPJ 00.000.000/0001-00\nRua Exemplo, 123 - Centro\nTel (00) 0000-0000'} />
              </Field>
              <Field label="Mensagem do rodapé">
                <textarea rows={2} maxLength={300} value={c.rodape} onChange={(e) => setC({ rodape: e.target.value })} />
              </Field>
              <div className="form-grid">
                <Field label="Largura do papel" style={{ flex: '0 0 170px' }}>
                  <select value={c.largura_mm} onChange={(e) => setC({ largura_mm: Number(e.target.value) })}>
                    <option value={80}>80 mm</option>
                    <option value={58}>58 mm</option>
                  </select>
                </Field>
                <Field label="Tamanho do nº do pedido" style={{ flex: '0 0 190px' }}>
                  <select value={c.tamanho_pedido} onChange={(e) => setC({ tamanho_pedido: e.target.value })}>
                    <option value="medio">Médio</option>
                    <option value="grande">Grande</option>
                    <option value="gigante">Gigante</option>
                  </select>
                </Field>
                <Field label="Vias do cupom" style={{ flex: '0 0 130px' }}>
                  <select value={c.vias} onChange={(e) => setC({ vias: Number(e.target.value) })}>
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </Field>
              </div>
              <Field label="Mostrar no cupom">
                <div className="permissoes-lista">
                  <Opcao rotulo="Nome da empresa" valor={c.mostrar_empresa} onChange={(v) => setC({ mostrar_empresa: v })} />
                  <Opcao rotulo="Nome da loja" valor={c.mostrar_loja} onChange={(v) => setC({ mostrar_loja: v })} />
                  <Opcao rotulo="Número da venda" valor={c.mostrar_numero_venda} onChange={(v) => setC({ mostrar_numero_venda: v })} />
                  <Opcao rotulo="Data e hora" valor={c.mostrar_data} onChange={(v) => setC({ mostrar_data: v })} />
                  <Opcao rotulo="PDV (terminal)" valor={c.mostrar_terminal} onChange={(v) => setC({ mostrar_terminal: v })} />
                  <Opcao rotulo="Operador" valor={c.mostrar_operador} onChange={(v) => setC({ mostrar_operador: v })} />
                  <Opcao rotulo="Código dos produtos" valor={c.mostrar_codigo_produto} onChange={(v) => setC({ mostrar_codigo_produto: v })} />
                  <Opcao rotulo="Observação do pedido (ex.: sem milho)" valor={c.mostrar_observacao} onChange={(v) => setC({ mostrar_observacao: v })} />
                  <Opcao rotulo="Desconto" valor={c.mostrar_desconto} onChange={(v) => setC({ mostrar_desconto: v })} />
                  <Opcao rotulo="Forma de pagamento" valor={c.mostrar_forma_pagamento} onChange={(v) => setC({ mostrar_forma_pagamento: v })} />
                  <Opcao rotulo="Valor recebido e troco" valor={c.mostrar_troco} onChange={(v) => setC({ mostrar_troco: v })} />
                </div>
              </Field>
              <Opcao rotulo="Imprimir o cupom automaticamente ao finalizar a venda" valor={c.imprimir_automatico} onChange={(v) => setC({ imprimir_automatico: v })} />
              {!loja.usa_comanda && <p className="form-hint">Dica: ative o número do pedido (comanda) na loja para o número aparecer em destaque no cupom.</p>}
            </>
          )}

          {aba === 'cozinha' && (
            <>
              <Opcao rotulo="Usar comanda da cozinha nesta loja (botão no PDV depois da venda)" valor={k.ativo} onChange={(v) => setK({ ativo: v })} />
              <Field label="Título da comanda">
                <input maxLength={200} value={k.cabecalho} onChange={(e) => setK({ cabecalho: e.target.value })} />
              </Field>
              <div className="form-grid">
                <Field label="Itens na comanda" style={{ flex: '1 1 220px' }}>
                  <select value={k.itens} onChange={(e) => setK({ itens: e.target.value })}>
                    <option value="preparo">Só o que é preparado (lanches e receitas)</option>
                    <option value="todos">Todos os itens da venda</option>
                  </select>
                </Field>
                <Field label="Largura do papel" style={{ flex: '0 0 150px' }}>
                  <select value={k.largura_mm} onChange={(e) => setK({ largura_mm: Number(e.target.value) })}>
                    <option value={80}>80 mm</option>
                    <option value={58}>58 mm</option>
                  </select>
                </Field>
                <Field label="Tamanho do nº do pedido" style={{ flex: '0 0 190px' }}>
                  <select value={k.tamanho_pedido} onChange={(e) => setK({ tamanho_pedido: e.target.value })}>
                    <option value="medio">Médio</option>
                    <option value="grande">Grande</option>
                    <option value="gigante">Gigante</option>
                  </select>
                </Field>
              </div>
              <Field label="Mostrar na comanda">
                <div className="permissoes-lista">
                  <Opcao rotulo="Nome da loja" valor={k.mostrar_loja} onChange={(v) => setK({ mostrar_loja: v })} />
                  <Opcao rotulo="Data e hora" valor={k.mostrar_data} onChange={(v) => setK({ mostrar_data: v })} />
                  <Opcao rotulo="Operador" valor={k.mostrar_operador} onChange={(v) => setK({ mostrar_operador: v })} />
                  <Opcao rotulo="Valores dos itens" valor={k.mostrar_valores} onChange={(v) => setK({ mostrar_valores: v })} />
                </div>
              </Field>
              <Opcao rotulo="Imprimir a comanda automaticamente ao finalizar a venda" valor={k.imprimir_automatico} onChange={(v) => setK({ imprimir_automatico: v })} />
              {!loja.usa_comanda && <p className="form-hint">Sem o número do pedido ativo na loja, a comanda mostra o número da venda.</p>}
            </>
          )}
        </div>

        <div className="config-cupom-previa">
          <div className="xml-secao-titulo">Prévia</div>
          <div className="previa-papel">
            {aba === 'cliente'
              ? <CupomCliente venda={venda} config={cfg} />
              : <ComandaCozinha venda={venda} config={cfg} />}
          </div>
          <p className="form-hint">Prévia com dados de exemplo. A impressão sai pela janela do navegador: escolha a impressora térmica e o papel de {aba === 'cliente' ? c.largura_mm : k.largura_mm} mm.</p>
        </div>
      </div>

      <div className="modal-actions">
        <button type="button" onClick={onClose}>Cancelar</button>
        <button type="button" disabled={salvando} onClick={salvar}>{salvando ? 'Salvando...' : 'Salvar configuração'}</button>
      </div>
    </Modal>
  );
}

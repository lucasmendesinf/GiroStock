import { textoComplementos } from './EscolherComplementos.jsx';
import { brl, dataHora, qtd, FORMA_PAGAMENTO } from '../utils/format';
import { useAuth } from '../context/AuthContext.jsx';

// Modo teste: todo documento impresso leva a faixa no topo e no rodape.
function FaixaTeste() {
  return <div className="cupom-centro"><strong>*** TESTE ***</strong></div>;
}

// Padrao da configuracao (igual ao do backend: backend/src/utils/cupom.js).
export const CONFIG_PADRAO = {
  geral: { impressao_separada: false },
  cliente: {
    largura_mm: 80, impressora: '', cabecalho: '', rodape: 'Obrigado pela preferência!',
    mostrar_empresa: true, mostrar_loja: true, mostrar_data: true, mostrar_numero_venda: true, mostrar_terminal: true,
    mostrar_operador: true, mostrar_codigo_produto: false, mostrar_observacao: true, mostrar_desconto: true, mostrar_forma_pagamento: true, mostrar_troco: true,
    tamanho_pedido: 'grande', vias: 1, imprimir_automatico: false,
  },
  cozinha: {
    ativo: false, largura_mm: 80, impressora: '', cabecalho: 'COMANDA DA COZINHA', itens: 'preparo',
    mostrar_loja: true, mostrar_data: true, mostrar_operador: false, mostrar_valores: false, tamanho_pedido: 'grande', imprimir_automatico: false,
  },
  senha: {
    ativo: false, largura_mm: 80, impressora: '', titulo: 'SENHA DO PEDIDO', mensagem: 'Apresente esta senha para retirar o seu pedido.',
    mostrar_itens: true, mostrar_loja: true, mostrar_data: true, tamanho_pedido: 'gigante', imprimir_automatico: false,
  },
};

export function configDaVenda(venda) {
  const c = (venda && venda.cupom_config) || {};
  return {
    geral: { ...CONFIG_PADRAO.geral, ...(c.geral || {}) },
    cliente: { ...CONFIG_PADRAO.cliente, ...(c.cliente || {}) },
    cozinha: { ...CONFIG_PADRAO.cozinha, ...(c.cozinha || {}) },
    senha: { ...CONFIG_PADRAO.senha, ...(c.senha || {}) },
  };
}

const larguraDoc = (mm) => `${mm === 58 ? 52 : 72}mm`;

function Pedido({ numero, tamanho }) {
  if (numero === null || numero === undefined) return null;
  return (
    <div className={`cupom-pedido cupom-pedido-${tamanho}`}>
      <div className="cupom-pedido-rotulo">PEDIDO</div>
      <div className="cupom-pedido-numero">Nº {numero}</div>
    </div>
  );
}

// Cupom do cliente (nao fiscal), conforme a configuracao da loja.
export function CupomCliente({ venda, config, teste }) {
  const c = config.cliente;
  return (
    <div className="cupom-doc" style={{ width: larguraDoc(c.largura_mm) }}>
      {teste && <FaixaTeste />}
      <div className="cupom-centro">
        {c.mostrar_empresa && <strong>{venda.empresa_nome}</strong>}
        {c.mostrar_loja && <div>{venda.location_nome}</div>}
        {c.cabecalho && <div className="cupom-texto">{c.cabecalho}</div>}
        <div>CUPOM NÃO FISCAL</div>
      </div>
      <Pedido numero={venda.numero_pedido} tamanho={c.tamanho_pedido} />
      <div className="cupom-linha" />
      {(c.mostrar_numero_venda || c.mostrar_data) && (
        <div>{c.mostrar_numero_venda ? `Venda nº ${venda.numero}` : ''}{c.mostrar_numero_venda && c.mostrar_data ? ' · ' : ''}{c.mostrar_data ? dataHora(venda.criado_em) : ''}</div>
      )}
      {(c.mostrar_terminal || c.mostrar_operador) && (
        <div>{c.mostrar_terminal ? venda.terminal_nome : ''}{c.mostrar_terminal && c.mostrar_operador ? ' · ' : ''}{c.mostrar_operador ? `Operador: ${venda.operador_nome}` : ''}</div>
      )}
      <div className="cupom-linha" />
      {venda.itens.map((i) => (
        <div key={i.id} className="cupom-item">
          <div>{c.mostrar_codigo_produto && i.codigo_interno ? `${i.codigo_interno} ` : ''}{i.product_nome}</div>
          <div className="cupom-dir">{qtd(i.quantidade, i.unidade)} {i.unidade} x {brl(i.preco_unitario)} = {brl(i.subtotal)}</div>
          {i.complementos && i.complementos.length > 0 && <div className="cupom-obs">{textoComplementos(i.complementos)}</div>}
          {c.mostrar_observacao && i.observacao && <div className="cupom-obs">Obs: {i.observacao}</div>}
        </div>
      ))}
      <div className="cupom-linha" />
      <div className="cupom-dir">Subtotal {brl(venda.subtotal)}</div>
      {c.mostrar_desconto && Number(venda.desconto) > 0 && <div className="cupom-dir">Desconto − {brl(venda.desconto)}</div>}
      {Number(venda.taxa_servico) > 0 && <div className="cupom-dir">Taxa de serviço + {brl(venda.taxa_servico)}</div>}
      <div className="cupom-dir cupom-total">TOTAL {brl(venda.total)}</div>
      {c.mostrar_forma_pagamento && (venda.pagamentos && venda.pagamentos.length > 1
        ? venda.pagamentos.map((p, k) => <div key={k} className="cupom-dir">{FORMA_PAGAMENTO[p.forma] || p.forma} {brl(p.valor)}</div>)
        : <div className="cupom-dir">{FORMA_PAGAMENTO[venda.forma_pagamento]}</div>)}
      {c.mostrar_troco && venda.troco !== null && venda.troco !== undefined && <div className="cupom-dir">Recebido {brl(venda.valor_recebido)} · Troco {brl(venda.troco)}</div>}
      {venda.status === 'cancelada' && <div className="cupom-centro"><strong>VENDA CANCELADA</strong></div>}
      {c.rodape && (<><div className="cupom-linha" /><div className="cupom-centro cupom-texto">{c.rodape}</div></>)}
      {teste && <FaixaTeste />}
    </div>
  );
}

// Comanda da cozinha: so o que precisa ser preparado, com o numero do pedido em destaque.
export function ComandaCozinha({ venda, config, teste }) {
  const k = config.cozinha;
  const itens = k.itens === 'todos' ? venda.itens : venda.itens.filter((i) => i.preparo);
  return (
    <div className="cupom-doc" style={{ width: larguraDoc(k.largura_mm) }}>
      {teste && <FaixaTeste />}
      <div className="cupom-centro">
        {k.cabecalho && <strong className="cupom-texto">{k.cabecalho}</strong>}
        {k.mostrar_loja && <div>{venda.location_nome}</div>}
      </div>
      <Pedido numero={venda.numero_pedido} tamanho={k.tamanho_pedido} />
      {venda.numero_pedido === null || venda.numero_pedido === undefined ? <div className="cupom-centro">Venda nº {venda.numero}</div> : null}
      {venda.pedido && (
        <div className="cupom-centro">
          <strong>{venda.pedido.origem} · {venda.pedido.tipo === 'entrega' ? 'ENTREGA' : venda.pedido.tipo === 'mesa' ? 'MESA' : venda.pedido.tipo === 'pista' ? 'PISTA' : 'RETIRADA'}</strong>
          {venda.pedido.rodada && <div>Rodada {venda.pedido.rodada}{venda.pedido.garcom ? ` · Garçom ${venda.pedido.garcom}` : ''}</div>}
          {venda.pedido.cliente && <div>{venda.pedido.cliente}{venda.pedido.telefone ? ` · ${venda.pedido.telefone}` : ''}</div>}
          {venda.pedido.tipo !== 'retirada' && venda.pedido.endereco && <div className="cupom-texto">{venda.pedido.endereco}</div>}
        </div>
      )}
      {k.mostrar_data && <div className="cupom-centro">{dataHora(venda.criado_em)}</div>}
      {k.mostrar_operador && <div className="cupom-centro">Operador: {venda.operador_nome}</div>}
      <div className="cupom-linha" />
      {itens.length === 0 && <div className="cupom-centro">Sem itens para preparar</div>}
      {venda.pedido && venda.pedido.observacao && <div className="cupom-obs cupom-obs-cozinha" style={{ paddingLeft: 0 }}>Obs.: {venda.pedido.observacao}</div>}
      {itens.map((i) => (
        <div key={i.id} className="cupom-item cupom-item-cozinha">
          <strong>{qtd(i.quantidade, i.unidade)}{i.unidade && i.unidade !== 'UN' ? ` ${i.unidade}` : 'x'}</strong> {i.product_nome}
          {k.mostrar_valores && <span className="cupom-dir"> {brl(i.subtotal)}</span>}
          {i.complementos && i.complementos.length > 0 && <div className="cupom-obs cupom-obs-cozinha">{textoComplementos(i.complementos)}</div>}
          {i.observacao && <div className="cupom-obs cupom-obs-cozinha">» {i.observacao}</div>}
        </div>
      ))}
      <div className="cupom-linha" />
      {teste && <FaixaTeste />}
    </div>
  );
}

// Senha do cliente: papel que o cliente guarda e apresenta quando o pedido sai (sem valores).
export function SenhaCliente({ venda, config, teste }) {
  const s = config.senha;
  return (
    <div className="cupom-doc" style={{ width: larguraDoc(s.largura_mm) }}>
      {teste && <FaixaTeste />}
      <div className="cupom-centro">
        {s.titulo && <strong className="cupom-texto">{s.titulo}</strong>}
        {s.mostrar_loja && <div>{venda.location_nome}</div>}
      </div>
      <Pedido numero={venda.numero_pedido} tamanho={s.tamanho_pedido} />
      {venda.numero_pedido === null || venda.numero_pedido === undefined ? <div className="cupom-centro">Venda nº {venda.numero}</div> : null}
      {s.mostrar_data && <div className="cupom-centro">{dataHora(venda.criado_em)}</div>}
      {s.mostrar_itens && (
        <>
          <div className="cupom-linha" />
          {venda.itens.map((i) => (
            <div key={i.id} className="cupom-item">
              <div>{qtd(i.quantidade, i.unidade)}{i.unidade && i.unidade !== 'UN' ? ` ${i.unidade}` : 'x'} {i.product_nome}</div>
              {i.complementos && i.complementos.length > 0 && <div className="cupom-obs">{textoComplementos(i.complementos)}</div>}
              {i.observacao && <div className="cupom-obs">Obs: {i.observacao}</div>}
            </div>
          ))}
        </>
      )}
      {s.mensagem && (<><div className="cupom-linha" /><div className="cupom-centro cupom-texto">{s.mensagem}</div></>)}
      {teste && <FaixaTeste />}
    </div>
  );
}

const ORDEM = ['cliente', 'cozinha', 'senha'];

// Aceita 'cliente' | 'cozinha' | 'senha' | 'ambos' (cliente + cozinha) | 'todos' | lista deles.
function modosDe(modo) {
  const lista = Array.isArray(modo) ? modo : modo === 'ambos' ? ['cliente', 'cozinha'] : modo === 'todos' ? ORDEM : [modo || 'cliente'];
  return ORDEM.filter((m) => lista.includes(m));
}

// Area de impressao (so aparece no print).
export default function Cupom({ venda }) {
  const { user } = useAuth();
  const teste = !!(user && user.modoTeste);
  const config = configDaVenda(venda);
  const modos = modosDe(venda.modo);
  const vias = Math.max(1, Number(config.cliente.vias) || 1);
  const docs = [];
  for (const m of modos) {
    if (m === 'cliente') for (let v = 0; v < vias; v += 1) docs.push(<CupomCliente key={`c${v}`} venda={venda} config={config} teste={teste} />);
    if (m === 'cozinha') docs.push(<ComandaCozinha key="k" venda={venda} config={config} teste={teste} />);
    if (m === 'senha') docs.push(<SenhaCliente key="s" venda={venda} config={config} teste={teste} />);
  }
  const primeiro = modos[0] || 'cliente';
  const largura = config[primeiro].largura_mm === 58 ? 58 : 80;
  return (
    <div className="cupom-print" aria-hidden="true">
      <style>{`@media print { @page { size: ${largura}mm auto; margin: 0; } }`}</style>
      {docs}
    </div>
  );
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const NOME_DOC = { cliente: 'cupom do cliente', cozinha: 'comanda da cozinha', senha: 'senha do cliente' };

// Renderiza os documentos e abre a janela de impressao do navegador.
// Por padrao sai um unico trabalho de impressao, com uma pagina (corte) por documento. Se a loja marcou
// "uma impressao para cada via", cada documento abre a sua propria impressao (da para mandar cada um
// para uma impressora diferente, ex.: caixa e cozinha).
// O navegador nao deixa o site escolher a impressora: se a loja informou qual impressora cada documento usa,
// o sistema mostra um aviso (por "avisar") dizendo qual escolher na janela de impressao.
export async function imprimirCupom(setCupom, venda, modo = 'cliente', avisar = null) {
  const modos = modosDe(modo);
  const config = configDaVenda(venda);
  const lembrete = (lista) => {
    if (!avisar) return;
    const partes = lista.filter((m) => config[m].impressora).map((m) => `${NOME_DOC[m]} → ${config[m].impressora}`);
    if (partes.length > 0) avisar(`Escolha a impressora na janela: ${partes.join(' · ')}`);
  };
  if (config.geral.impressao_separada && modos.length > 1) {
    for (const m of modos) {
      setCupom({ ...venda, modo: [m] });
      lembrete([m]);
      await esperar(200);
      window.print();
      await esperar(300);
    }
    return;
  }
  const impressoras = new Set(modos.map((m) => config[m].impressora).filter(Boolean));
  if (impressoras.size > 1 && avisar) avisar('Os documentos saem numa única impressão. Para usar impressoras diferentes, marque "uma impressão para cada via" nas configurações da loja.');
  else lembrete(modos);
  setCupom({ ...venda, modo: modos });
  await esperar(150);
  window.print();
}

// Impressao automatica configurada na loja: devolve a lista de documentos ou null.
export function modoAutomatico(venda) {
  const c = configDaVenda(venda);
  const modos = [];
  if (c.cliente.imprimir_automatico) modos.push('cliente');
  if (c.cozinha.ativo && c.cozinha.imprimir_automatico) modos.push('cozinha');
  if (c.senha.ativo && c.senha.imprimir_automatico) modos.push('senha');
  return modos.length > 0 ? modos : null;
}

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useConfirm, useToast } from '../context/UiContext.jsx';
import { Modal } from './ui.jsx';

const ROTULO = {
  aguardando_codigo: ['warn', 'Aguardando autorização'], conectado: ['ok', 'Conectado'], reautorizar: ['err', 'Autorizar de novo'], desconectado: ['', 'Desconectado'],
};
const quando = (v) => (v ? new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'nenhum ainda');

// 99Food por loja (Lojas & PDVs): o GiroStock gera o codigo da loja, a loja autoriza o app no portal da 99Food com ele
// e o GiroStock confere. Os pedidos chegam na hora (a 99Food avisa o GiroStock a cada pedido).
export default function Food99Conexoes({ lojas }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [dados, setDados] = useState(null);
  const [conectando, setConectando] = useState(null); // { loja, id, codigo }

  const carregar = useCallback(() => api.get('/integracoes').then(setDados).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  if (!dados) return null;

  const porLoja = Object.fromEntries(dados.integracoes.filter((i) => i.plataforma === '99food').map((i) => [i.location_id, i]));
  async function conectar(loja) {
    try { const r = await api.post('/integracoes/99food/conectar', { location_id: loja.id }); setConectando({ loja, ...r }); carregar(); } catch (err) { toast.erro(err); }
  }
  async function alternarAceite(i) {
    try { await api.patch(`/integracoes/${i.id}`, { aceite_automatico: !i.aceite_automatico }); toast.sucesso(!i.aceite_automatico ? 'Aceite automático ligado' : 'Aceite automático desligado'); carregar(); } catch (err) { toast.erro(err); }
  }
  async function testar(i) {
    try { await api.post(`/integracoes/${i.id}/sincronizar`); toast.sucesso('Conexão com a 99Food funcionando'); } catch (err) { toast.erro(err); } finally { carregar(); }
  }
  async function desconectar(i, loja) {
    if (!(await confirmar({ titulo: `Desconectar a 99Food da loja ${loja.nome}?`, mensagem: 'Os pedidos da 99Food deixam de entrar no GiroStock. Para voltar, é preciso conectar de novo.', confirmar: 'Desconectar', perigo: true }))) return;
    try { await api.del(`/integracoes/${i.id}`); toast.sucesso('99Food desconectada'); carregar(); } catch (err) { toast.erro(err); }
  }

  return (
    <div className="card ifood-card">
      <div className="ped-head" style={{ margin: '0 0 6px' }}><h3 style={{ margin: 0 }}><span className="ped-tag food99">99Food</span> Receber pedidos da 99Food</h3></div>
      <p className="form-hint" style={{ marginTop: 0 }}>Os pedidos da 99Food entram na hora na tela <b>Pedidos</b> da loja conectada, reservam o estoque e o aceite, o preparo, a entrega e os cancelamentos ficam sincronizados com a 99Food.</p>
      {!dados.food99_configurado && <div className="ped-nota" style={{ borderColor: 'var(--warn)' }}>A integração ainda não foi ativada no servidor (aguardando as credenciais do app no portal de desenvolvedores da 99Food).</div>}
      {lojas.filter((l) => l.ativo).map((l) => {
        const i = porLoja[l.id];
        const [cor, rot] = ROTULO[i ? i.status : 'desconectado'] || ROTULO.desconectado;
        const ligado = i && i.status === 'conectado';
        return (
          <div key={l.id} className="ifood-loja">
            <div>
              <b>{l.nome}</b> <span className={`ped-pill ${cor}`}>{rot}</span>
              {ligado && <div className="form-hint" style={{ margin: '2px 0 0' }}>Loja na 99Food: <b>{i.merchant_nome || 'aparece no 1º pedido'}</b> · código {i.merchant_id} · último pedido/aviso {quando(i.ultimo_polling_em)}</div>}
              {i && i.ultimo_erro && i.status !== 'desconectado' && <div className="form-hint" style={{ margin: '2px 0 0', color: 'var(--err)' }}>Último problema ({quando(i.ultimo_erro_em)}): {i.ultimo_erro}</div>}
            </div>
            <div className="row-actions" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              {ligado && (
                <label className="check" title="Aceita na 99Food assim que o pedido chega, se todos os itens estão vinculados e há estoque">
                  <input type="checkbox" checked={i.aceite_automatico} onChange={() => alternarAceite(i)} /> Aceitar automaticamente
                </label>
              )}
              {ligado && <button type="button" className="btn-link" onClick={() => testar(i)}>Testar conexão</button>}
              {ligado && <button type="button" className="btn-link perigo" onClick={() => desconectar(i, l)}>Desconectar</button>}
              {!ligado && i && (i.status === 'aguardando_codigo' || i.status === 'reautorizar') && i.merchant_id && (
                <button type="button" className={i.status === 'reautorizar' ? 'btn-primario' : 'btn-link'} onClick={() => setConectando({ loja: l, id: i.id, codigo: i.merchant_id })}>{i.status === 'reautorizar' ? 'Autorizar de novo' : 'Continuar conexão'}</button>
              )}
              {!ligado && (!i || i.status === 'desconectado') && dados.food99_configurado && <button type="button" className="btn-primario" onClick={() => conectar(l)}>Conectar 99Food</button>}
            </div>
          </div>
        );
      })}
      {conectando && <ConectarModal estado={conectando} onClose={() => { setConectando(null); carregar(); }} />}
    </div>
  );
}

function ConectarModal({ estado, onClose }) {
  const toast = useToast();
  const [conferindo, setConferindo] = useState(false);
  async function conferir() {
    setConferindo(true);
    try { await api.post(`/integracoes/${estado.id}/concluir`); toast.sucesso(`99Food conectada na loja ${estado.loja.nome}`); onClose(); } catch (err) { toast.erro(err); } finally { setConferindo(false); }
  }
  return (
    <Modal titulo={`Conectar a 99Food · ${estado.loja.nome}`} onClose={onClose} largura="larga">
      <div className="form-stack">
        <ol className="ifood-passos">
          <li>Entre no <b>portal da 99Food para lojas</b> com o login da loja e abra a área de <b>integrações / aplicativos</b>.</li>
          <li>Escolha o <b>GiroStock</b> e informe o código desta loja: <span className="ifood-codigo">{estado.codigo}</span></li>
          <li>Autorize. Depois volte aqui e clique em <b>Já autorizei</b>.</li>
        </ol>
        <p className="form-hint">No app da 99Food para lojas, deixe o modo de pedidos que permite integração (app + OpenAPI): assim a loja pode aceitar pelo GiroStock ou pelo app.</p>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Depois</button>
          <button type="button" className="btn-primario" disabled={conferindo} onClick={conferir}>{conferindo ? 'Conferindo…' : 'Já autorizei: conectar'}</button>
        </div>
      </div>
    </Modal>
  );
}

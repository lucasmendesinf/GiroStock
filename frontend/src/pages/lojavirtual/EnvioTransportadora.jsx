import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';
import { Field } from '../../components/ui.jsx';
import { brl, parseNumero } from '../../utils/format';

const valor = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
const soDigitos = (v) => String(v || '').replace(/\D/g, '');

// Envio por transportadora (Melhor Envio) da loja online: conta do lojista, remetente, servicos oferecidos e regras.
export default function EnvioTransportadora({ config, onMudou }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const e = config.envio;
  const [conexao, setConexao] = useState({ token: '', sandbox: false });
  const [conta, setConta] = useState(null); // { servicos, saldo }
  const [f, setF] = useState(() => ({
    ativo: e.ativo, servicos: e.servicos, declaracao: e.declaracao,
    dias_extra: String(e.dias_extra), acrescimo: valor(e.acrescimo), gratis_acima: valor(e.gratis_acima),
    remetente: { nome: '', telefone: '', email: '', documento: '', cep: '', logradouro: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '', ...e.remetente },
    padrao: { peso_kg: valor(e.padrao.peso_kg), altura_cm: valor(e.padrao.altura_cm), largura_cm: valor(e.padrao.largura_cm), comprimento_cm: valor(e.padrao.comprimento_cm) },
  }));
  const [salvando, setSalvando] = useState(false);
  const [simCep, setSimCep] = useState('');
  const [sim, setSim] = useState(null);
  const carregarConta = useCallback(() => {
    if (!e.conectado) return;
    api.get('/loja-virtual/envio/servicos').then(setConta).catch((err) => setConta({ erro: err.message }));
  }, [e.conectado]);
  useEffect(() => { carregarConta(); }, [carregarConta]);

  async function conectar(ev) {
    ev.preventDefault();
    try {
      const r = await api.put('/loja-virtual/envio/conta', conexao);
      toast.sucesso(`Conta conectada: ${r.conta}`);
      setConexao({ token: '', sandbox: false });
      await onMudou();
    } catch (err) { toast.erro(err); }
  }
  async function desconectar() {
    if (!(await confirmar({ titulo: 'Desconectar o Melhor Envio?', mensagem: 'O site deixa de oferecer envio por transportadora até você conectar de novo.', confirmar: 'Desconectar', perigo: true }))) return;
    try { await api.del('/loja-virtual/envio/conta'); toast.sucesso('Melhor Envio desconectado'); await onMudou(); } catch (err) { toast.erro(err); }
  }
  const rem = (k) => (ev) => setF({ ...f, remetente: { ...f.remetente, [k]: ev.target.value } });
  async function buscarCep() {
    const c = soDigitos(f.remetente.cep);
    if (c.length !== 8) return;
    try {
      const r = await (await fetch(`https://viacep.com.br/ws/${c}/json/`)).json();
      if (r && !r.erro) setF((x) => ({ ...x, remetente: { ...x.remetente, logradouro: x.remetente.logradouro || r.logradouro || '', bairro: x.remetente.bairro || r.bairro || '', cidade: r.localidade || x.remetente.cidade, uf: r.uf || x.remetente.uf } }));
    } catch { /* sem internet: preenche a mao */ }
  }
  async function salvar(ev) {
    ev.preventDefault();
    setSalvando(true);
    try {
      await api.put('/loja-virtual/envio', {
        ativo: f.ativo, servicos: f.servicos, declaracao: f.declaracao,
        dias_extra: Number(f.dias_extra) || 0, acrescimo: parseNumero(f.acrescimo) || 0, gratis_acima: f.gratis_acima.trim() ? parseNumero(f.gratis_acima) : null,
        remetente: { ...f.remetente, cep: soDigitos(f.remetente.cep), documento: soDigitos(f.remetente.documento), telefone: soDigitos(f.remetente.telefone) },
        padrao: Object.fromEntries(Object.entries(f.padrao).map(([k, v]) => [k, parseNumero(v)])),
      });
      toast.sucesso('Envio por transportadora salvo');
      await onMudou();
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  async function simular(ev) {
    ev.preventDefault();
    try { setSim(await api.post('/loja-virtual/envio/simular', { cep: soDigitos(simCep) })); } catch (err) { setSim(null); toast.erro(err); }
  }
  const marcarServico = (id, sim2) => setF({ ...f, servicos: sim2 ? [...f.servicos, id] : f.servicos.filter((x) => x !== id) });

  return (
    <div className="form-stack">
      <div className="card form-stack">
        <div className="ped-head" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: 0 }}>Envio por transportadora (Melhor Envio)</h3>
          {e.conectado && <span className={`ped-pill ${e.disponivel ? 'ok' : 'warn'}`}>{e.disponivel ? 'Oferecido no site' : 'Desligado no site'}</span>}
        </div>
        <p className="form-hint" style={{ margin: 0 }}>
          O cliente informa o CEP e escolhe entre Correios, Jadlog e as outras transportadoras da sua conta, com preço e prazo na hora. No pedido, você compra a etiqueta aqui mesmo (com o saldo da sua conta do Melhor Envio), imprime e o código de rastreio vai sozinho para o cliente.
        </p>
        {!e.conectado ? (
          <form className="form-stack" onSubmit={conectar}>
            <ol className="lv-passos">
              <li>Crie ou entre na sua conta em <b>melhorenvio.com.br</b> e coloque saldo na carteira.</li>
              <li>Em <b>Integrações › Permissões de acesso</b>, clique em <b>Gerar novo token</b> e marque as permissões de carrinho, cotação, compra, geração, impressão, rastreio e cancelamento de envios.</li>
              <li>Cole o token abaixo.</li>
            </ol>
            <Field label="Token do Melhor Envio"><textarea rows={3} value={conexao.token} onChange={(ev) => setConexao({ ...conexao, token: ev.target.value })} placeholder="eyJ0eXAiOiJKV1Qi…" required /></Field>
            <label className="check"><input type="checkbox" checked={conexao.sandbox} onChange={(ev) => setConexao({ ...conexao, sandbox: ev.target.checked })} /> Conta de testes (sandbox)</label>
            <div><button type="submit" className="btn-primario">Conectar</button></div>
          </form>
        ) : (
          <div className="lv-conta-me">
            <div>
              <b>{e.conta}</b>{e.sandbox && <span className="ped-pill warn lv-mini">sandbox</span>}
              <div className="celula-sub">
                {conta && conta.erro ? <span className="erro-texto">{conta.erro}</span> : conta ? `Saldo: ${conta.saldo === null ? '—' : brl(conta.saldo)}` : 'Conferindo a conta…'}
              </div>
            </div>
            <button type="button" className="btn-link perigo" onClick={desconectar}>Desconectar</button>
          </div>
        )}
      </div>

      {e.conectado && (
        <form className="card form-stack" onSubmit={salvar}>
          <label className="check"><input type="checkbox" checked={f.ativo} onChange={(ev) => setF({ ...f, ativo: ev.target.checked })} /> <b>Oferecer envio por transportadora no site</b></label>
          {config.aceita_entrega && <p className="form-hint" style={{ margin: 0 }}>A entrega da loja pelos bairros continua valendo só na cidade de origem ({f.remetente.cidade || 'informe abaixo'}); fora dela, o cliente escolhe a transportadora.</p>}

          <h4 style={{ margin: '8px 0 0' }}>Remetente (vai na etiqueta)</h4>
          <div className="form-grid lv-grid-3">
            <Field label="Nome ou razão social *"><input value={f.remetente.nome} onChange={rem('nome')} maxLength={80} /></Field>
            <Field label="CPF ou CNPJ *"><input value={f.remetente.documento} onChange={rem('documento')} inputMode="numeric" /></Field>
            <Field label="Telefone *"><input value={f.remetente.telefone} onChange={rem('telefone')} inputMode="tel" /></Field>
            <Field label="E-mail"><input type="email" value={f.remetente.email} onChange={rem('email')} /></Field>
            <Field label="CEP de origem *"><input value={f.remetente.cep} onChange={rem('cep')} onBlur={buscarCep} inputMode="numeric" placeholder="00000-000" /></Field>
            <Field label="Rua *"><input value={f.remetente.logradouro} onChange={rem('logradouro')} /></Field>
            <Field label="Número *"><input value={f.remetente.numero} onChange={rem('numero')} /></Field>
            <Field label="Complemento"><input value={f.remetente.complemento} onChange={rem('complemento')} /></Field>
            <Field label="Bairro *"><input value={f.remetente.bairro} onChange={rem('bairro')} /></Field>
            <Field label="Cidade *"><input value={f.remetente.cidade} onChange={rem('cidade')} /></Field>
            <Field label="UF *"><input value={f.remetente.uf} onChange={(ev) => setF({ ...f, remetente: { ...f.remetente, uf: ev.target.value.toUpperCase().slice(0, 2) } })} maxLength={2} /></Field>
          </div>

          <h4 style={{ margin: '8px 0 0' }}>Serviços oferecidos</h4>
          {!conta ? <p className="muted">Carregando…</p> : conta.erro ? <p className="erro-texto">{conta.erro}</p> : (
            <>
              <div className="lv-servicos">
                {conta.servicos.map((s) => (
                  <label key={s.id} className="check">
                    <input type="checkbox" checked={f.servicos.includes(s.id)} onChange={(ev) => marcarServico(s.id, ev.target.checked)} />
                    {s.logo && <img src={s.logo} alt="" onError={(ev) => { ev.currentTarget.style.display = 'none'; }} />} {s.transportadora} {s.nome}
                  </label>
                ))}
              </div>
              <p className="form-hint" style={{ margin: 0 }}>Nenhum marcado = todos os serviços da sua conta que atenderem o CEP.</p>
            </>
          )}

          <h4 style={{ margin: '8px 0 0' }}>Regras</h4>
          <div className="form-grid lv-grid-3">
            <Field label="Dias para separar" hint="Somados ao prazo da transportadora"><input inputMode="numeric" value={f.dias_extra} onChange={(ev) => setF({ ...f, dias_extra: ev.target.value })} /></Field>
            <Field label="Acréscimo no frete (R$)" hint="Embalagem, manuseio"><input inputMode="decimal" value={f.acrescimo} onChange={(ev) => setF({ ...f, acrescimo: ev.target.value })} placeholder="0,00" /></Field>
            <Field label="Frete grátis a partir de (R$)" hint="Vale para o frete mais barato"><input inputMode="decimal" value={f.gratis_acima} onChange={(ev) => setF({ ...f, gratis_acima: ev.target.value })} placeholder="sem frete grátis" /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={f.declaracao} onChange={(ev) => setF({ ...f, declaracao: ev.target.checked })} /> Enviar com declaração de conteúdo (sem NF-e). Desmarcado: a chave da NF-e é pedida ao comprar a etiqueta.</label>

          <h4 style={{ margin: '8px 0 0' }}>Embalagem padrão</h4>
          <p className="form-hint" style={{ margin: 0 }}>Usada para os produtos sem peso e medidas (cadastre em Produtos no site para um frete mais exato).</p>
          <div className="form-grid lv-grid-4">
            <Field label="Peso (kg)"><input inputMode="decimal" value={f.padrao.peso_kg} onChange={(ev) => setF({ ...f, padrao: { ...f.padrao, peso_kg: ev.target.value } })} /></Field>
            <Field label="Altura (cm)"><input inputMode="decimal" value={f.padrao.altura_cm} onChange={(ev) => setF({ ...f, padrao: { ...f.padrao, altura_cm: ev.target.value } })} /></Field>
            <Field label="Largura (cm)"><input inputMode="decimal" value={f.padrao.largura_cm} onChange={(ev) => setF({ ...f, padrao: { ...f.padrao, largura_cm: ev.target.value } })} /></Field>
            <Field label="Comprimento (cm)"><input inputMode="decimal" value={f.padrao.comprimento_cm} onChange={(ev) => setF({ ...f, padrao: { ...f.padrao, comprimento_cm: ev.target.value } })} /></Field>
          </div>
          {e.pendencias.length > 0 && <p className="form-hint" style={{ color: 'var(--warn)', margin: 0 }}>Falta: {e.pendencias.join('; ')}.</p>}
          <div><button type="submit" className="btn-primario" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</button></div>
        </form>
      )}

      {e.conectado && e.remetente.cep && (
        <form className="card form-stack" onSubmit={simular}>
          <h3 style={{ margin: 0 }}>Simular frete</h3>
          <p className="form-hint" style={{ margin: 0 }}>Um pacote com a embalagem padrão, da origem até o CEP (preço com o acréscimo; custo = o que o Melhor Envio cobra).</p>
          <div className="lv-linha-simular">
            <input value={simCep} onChange={(ev) => setSimCep(ev.target.value)} placeholder="CEP de destino" inputMode="numeric" aria-label="CEP de destino" />
            <button type="submit">Simular</button>
          </div>
          {sim && (sim.opcoes.length === 0 ? <p className="muted">Nenhum serviço atende este CEP.</p> : (
            <table className="tabela-cartoes">
              <thead><tr><th>Serviço</th><th className="num">Prazo</th><th className="num">Custo</th><th className="num">No site</th></tr></thead>
              <tbody>{sim.opcoes.map((o) => <tr key={o.id}><td>{o.nome}</td><td className="num">{o.prazo_dias ? `${o.prazo_dias} dias úteis` : '—'}</td><td className="num">{brl(o.custo)}</td><td className="num">{brl(o.preco)}</td></tr>)}</tbody>
            </table>
          ))}
        </form>
      )}
    </div>
  );
}

import { Link } from 'react-router-dom';
import { useLoja } from '../estado.jsx';
import { brl, DIAS, fmtTel, soDigitos } from '../util';

const NA_ENTREGA = { dinheiro: 'Dinheiro', pix: 'Pix na entrega', cartao: 'Cartão na maquininha' };

// Perfil da loja: sobre, horarios, entrega (bairros e taxas), pagamentos e contato.
export default function Perfil() {
  const { loja } = useLoja();
  const c = loja.contato;
  const pg = loja.pagamentos;
  const formas = [...(pg.pix_online ? ['Pix pelo site'] : []), ...(pg.cartao_online ? [`Cartão de crédito pelo site${pg.parcelas_max > 1 ? ` (até ${pg.parcelas_max}x)` : ''}`] : []), ...pg.na_entrega.map((f) => NA_ENTREGA[f])];
  const dias = Object.keys(loja.horarios || {});
  return (
    <section className="bloco caixa-media perfil">
      <div className="perfil-topo">
        {loja.logo && <img src={loja.logo} alt="" />}
        <div><h1>{loja.nome}</h1>{loja.descricao && <p>{loja.descricao}</p>}</div>
      </div>
      <div className="painel">
        <h2>Horários</h2>
        <p className={loja.recebendo_pedidos ? 'ok-texto' : 'erro-texto'}>{loja.recebendo_pedidos ? 'Aberta agora' : (loja.motivo_fechada || 'Fechada')}</p>
        {dias.length === 0 ? <p>Todos os dias</p> : DIAS.map((nome, d) => (
          <p key={nome} className="horario-linha"><span>{nome}</span><span>{(loja.horarios[d] || []).length ? loja.horarios[d].map((f) => `${f.de}–${f.ate}`).join(', ') : 'fechado'}</span></p>
        ))}
      </div>
      {loja.entrega.aceita && (
        <div className="painel">
          <h2>Entrega</h2>
          <p className="dica">Tempo estimado: cerca de {loja.entrega.tempo_estimado_min} min{loja.pedido_minimo > 0 ? ` · pedido mínimo ${brl(loja.pedido_minimo)}` : ''}</p>
          {loja.entrega.bairros.map((b) => <p key={b.id} className="horario-linha"><span>{b.nome}</span><span>{b.taxa > 0 ? brl(b.taxa) : 'Grátis'}</span></p>)}
          {loja.entrega.outros_bairros && <p className="horario-linha"><span>Outros bairros</span><span>{brl(loja.entrega.outros_bairros.taxa)}</span></p>}
        </div>
      )}
      {loja.retirada.aceita && <div className="painel"><h2>Retirada</h2><p>{c.endereco || 'Na loja'}{loja.retirada.tempo_estimado_min ? ` · pronto em ~${loja.retirada.tempo_estimado_min} min` : ''}</p></div>}
      <div className="painel"><h2>Formas de pagamento</h2>{formas.map((f) => <p key={f}>• {f}</p>)}</div>
      <div className="painel">
        <h2>Contato</h2>
        {c.endereco && <p>📍 {c.endereco}</p>}
        {c.whatsapp && <p><a href={`https://wa.me/55${soDigitos(c.whatsapp)}`} target="_blank" rel="noreferrer">WhatsApp {fmtTel(c.whatsapp)}</a></p>}
        {c.telefone && <p>Telefone {fmtTel(c.telefone)}</p>}
        {c.instagram && <p><a href={`https://instagram.com/${c.instagram.replace('@', '')}`} target="_blank" rel="noreferrer">Instagram {c.instagram.startsWith('@') ? c.instagram : `@${c.instagram}`}</a></p>}
        {c.email && <p><a href={`mailto:${c.email}`}>{c.email}</a></p>}
      </div>
      <Link to="/" className="link centro">Voltar</Link>
    </section>
  );
}

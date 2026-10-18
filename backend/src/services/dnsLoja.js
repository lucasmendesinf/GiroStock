// Conferencia de DNS dos dominios proprios das lojas: o dominio precisa apontar para este servidor.
//  - LOJA_DNS_ALVO: nome para o CNAME (ex.: lojas.calutec.com.br) — o cliente cria "www CNAME lojas.calutec.com.br".
//  - LOJA_DNS_IP:   IP do servidor (para o dominio sem www, que usa registro A). Sem ele, usa os IPs do alvo.
const dns = require('dns').promises;

const alvo = () => ({
  cname: String(process.env.LOJA_DNS_ALVO || '').trim().toLowerCase() || null,
  ip: String(process.env.LOJA_DNS_IP || '').trim() || null,
});

function comTempo(promessa, ms = 4000) {
  return Promise.race([promessa, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('tempo esgotado'), { code: 'ETIMEOUT' })), ms))]);
}
const tentar = async (fn) => { try { return await comTempo(fn()); } catch (err) { return err.code === 'ENODATA' || err.code === 'ENOTFOUND' ? [] : null; } };

// { dominio, situacao: 'ok' | 'aponta_outro' | 'sem_registro' | 'nao_configurado' | 'erro', cname: [], ips: [], mensagem }
async function conferir(dominio) {
  const a = alvo();
  if (!a.cname && !a.ip) return { dominio, situacao: 'nao_configurado', cname: [], ips: [], mensagem: 'servidor sem LOJA_DNS_ALVO/LOJA_DNS_IP: não dá para conferir' };
  const cname = await tentar(() => dns.resolveCname(dominio));
  const ips = await tentar(() => dns.resolve4(dominio));
  if (cname === null && ips === null) return { dominio, situacao: 'erro', cname: [], ips: [], mensagem: 'não foi possível consultar o DNS agora' };
  const nomes = (cname || []).map((c) => c.toLowerCase().replace(/\.$/, ''));
  if (a.cname && nomes.includes(a.cname)) return { dominio, situacao: 'ok', cname: nomes, ips: ips || [], mensagem: 'apontando corretamente' };
  let ipsAlvo = a.ip ? [a.ip] : [];
  if (!ipsAlvo.length && a.cname) ipsAlvo = (await tentar(() => dns.resolve4(a.cname))) || [];
  if ((ips || []).some((ip) => ipsAlvo.includes(ip))) return { dominio, situacao: 'ok', cname: nomes, ips, mensagem: 'apontando corretamente' };
  if (!nomes.length && !(ips || []).length) return { dominio, situacao: 'sem_registro', cname: [], ips: [], mensagem: 'domínio ainda sem registro no DNS' };
  return { dominio, situacao: 'aponta_outro', cname: nomes, ips: ips || [], mensagem: `aponta para ${nomes[0] || (ips || []).join(', ')}` };
}

module.exports = { alvo, conferir };

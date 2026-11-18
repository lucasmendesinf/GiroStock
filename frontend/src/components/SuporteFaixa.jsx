import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast, useConfirm } from '../context/UiContext.jsx';

function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Faixa fixa durante o suporte do Master (nao pode ser escondida): empresa, modo, contagem regressiva e "Encerrar suporte".
export default function SuporteFaixa() {
  const { user, encerrarSuporte, voltarAoMasterLocal, testarSemGravar } = useAuth();
  const toast = useToast();
  const confirmar = useConfirm();
  const [copiando, setCopiando] = useState(false);

  // Aviso de teste encerrado (2 h parado, suporte encerrado...) depois de voltar ao suporte.
  useEffect(() => {
    let aviso = null;
    try { aviso = sessionStorage.getItem('girostock_aviso_teste'); sessionStorage.removeItem('girostock_aviso_teste'); } catch { /* sem armazenamento */ }
    if (aviso) toast.erro(aviso);
  }, [toast]);
  const fim = user && user.suporte ? new Date(user.suporte.expiraEm).getTime() : null;
  const [restante, setRestante] = useState(fim ? fim - Date.now() : 0);

  useEffect(() => {
    if (!fim) return undefined;
    const t = setInterval(() => {
      const r = fim - Date.now();
      setRestante(r);
      if (r <= 0) { clearInterval(t); voltarAoMasterLocal('A sessão de suporte expirou (30 minutos).'); }
    }, 1000);
    return () => clearInterval(t);
  }, [fim, voltarAoMasterLocal]);

  if (!user || !user.suporte) return null;
  async function encerrar() {
    try { await encerrarSuporte(); window.location.assign('/master/empresas'); } catch (err) { toast.erro(err); }
  }
  async function testar() {
    const ok = await confirmar({
      titulo: 'Testar sem gravar',
      mensagem: `Uma cópia de ${user.suporte.empresa} (cadastros, estoque atual e os últimos 30 dias de movimento) vai para o banco de teste. `
        + 'Lá você entra como administrador e pode fazer vendas, caixa, estoque e pedidos à vontade: nada é gravado na conta do cliente. '
        + 'As integrações (iFood, WhatsApp, nota fiscal) ficam desligadas/simuladas. A cópia é apagada ao encerrar o teste, '
        + 'quando o suporte acabar ou depois de 2 horas parado. Se a empresa tiver dados próprios no modo teste, eles serão substituídos.',
      confirmar: 'Copiar e testar',
    });
    if (!ok) return;
    setCopiando(true);
    try { await testarSemGravar(); window.location.assign('/inicio'); } catch (err) { toast.erro(err); setCopiando(false); }
  }
  return (
    <div className="faixa-suporte" role="alert">
      <span>SUPORTE — acessando <b>{user.suporte.empresa}</b> como administrador · {user.suporte.edicao ? 'edição liberada' : 'somente leitura'} · expira em <b>{mmss(restante)}</b></span>
      <button type="button" onClick={testar} disabled={copiando}>{copiando ? 'Copiando…' : '🧪 Testar sem gravar'}</button>
      <button type="button" onClick={encerrar}>Encerrar suporte</button>
    </div>
  );
}

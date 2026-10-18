import { useEffect, useRef, useState } from 'react';

// Formulario de cartao do proprio Mercado Pago (Card Payment Brick): o numero do cartao e digitado num campo do
// Mercado Pago e vira um token; so o token chega a loja. onPagar recebe os dados no formato da API da loja.
let sdk = null;
function carregarSdk() {
  if (window.MercadoPago) return Promise.resolve();
  if (!sdk) {
    sdk = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://sdk.mercadopago.com/js/v2';
      s.onload = resolve;
      s.onerror = () => { sdk = null; reject(new Error('não foi possível carregar o pagamento com cartão')); };
      document.head.appendChild(s);
    });
  }
  return sdk;
}

let contador = 0;
export default function CartaoMercadoPago({ publicKey, valor, email, parcelasMax, onPagar }) {
  const idRef = useRef(`mp-cartao-${++contador}`);
  const pagar = useRef(onPagar);
  pagar.current = onPagar;
  const [erro, setErro] = useState(null);
  const [pronto, setPronto] = useState(false);
  useEffect(() => {
    let controle = null;
    let cancelado = false;
    carregarSdk().then(async () => {
      if (cancelado) return;
      const mp = new window.MercadoPago(publicKey, { locale: 'pt-BR' });
      controle = await mp.bricks().create('cardPayment', idRef.current, {
        initialization: { amount: Number(valor.toFixed(2)), payer: { email } },
        customization: { paymentMethods: { maxInstallments: parcelasMax, types: { excluded: ['debit_card'] } }, visual: { hideFormTitle: true } },
        callbacks: {
          onReady: () => setPronto(true),
          onError: () => setErro('Confira os dados do cartão.'),
          onSubmit: (d) => pagar.current({
            token: d.token, payment_method_id: d.payment_method_id, issuer_id: d.issuer_id, parcelas: d.installments,
            identificacao: d.payer && d.payer.identification ? { tipo: d.payer.identification.type, numero: d.payer.identification.number } : undefined,
          }),
        },
      });
    }).catch((e) => setErro(e.message));
    return () => { cancelado = true; if (controle) controle.unmount(); };
  }, [publicKey, valor, email, parcelasMax]);
  return (
    <div className="mp-cartao">
      {!pronto && !erro && <p className="dica">Carregando o pagamento seguro do Mercado Pago…</p>}
      {erro && <p className="erro-texto">{erro}</p>}
      <div id={idRef.current} />
    </div>
  );
}

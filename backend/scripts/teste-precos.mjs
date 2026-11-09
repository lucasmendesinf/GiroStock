// Testes unitarios das regras puras de preco por faixa de quantidade (services/precos.js). Sem banco, sem servidor.
//   node scripts/teste-precos.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { cent, reais, precoDaFaixaEmCentavos, validarFaixasDaLoja, escolherFaixa, itensParaPreco } = require('../src/services/precos.js');

let ok = 0; let falhas = 0;
const check = (nome, cond, extra) => { if (cond) { ok++; console.log('  ok  ', nome); } else { falhas++; console.log('  FALHA', nome, extra === undefined ? '' : JSON.stringify(extra)); } };
const lanca = (fn) => { try { fn(); return null; } catch (e) { return e; } };

console.log('\n# centavos');
check('cent(9.5) = 950', cent(9.5) === 950);
check('cent(1.005) arredonda para 101 (sem erro de ponto flutuante)', cent(1.005) === 101, cent(1.005));
check('cent("7,20" como 7.2) = 720', cent(7.2) === 720);
check('cent(0.1 + 0.2) = 30', cent(0.1 + 0.2) === 30);
check('reais(800) = 8', reais(800) === 8);

console.log('\n# preco da faixa pelo modo de cadastro');
check('unitario 8,00 -> 800', precoDaFaixaEmCentavos({ modo: 'unitario', valor: 8, quantidade_minima: 6 }, 950) === 800);
check('kit R$ 48,00 / 6 un -> 800 por unidade', precoDaFaixaEmCentavos({ modo: 'kit', valor: 48, quantidade_minima: 6 }, 950) === 800);
const eKit = lanca(() => precoDaFaixaEmCentavos({ modo: 'kit', valor: 50, quantidade_minima: 6 }, 950));
check('kit R$ 50,00 / 6 un nao divide em centavos -> 400', eKit && eKit.status === 400 && /não divide em centavos/.test(eKit.message), eKit && eKit.message);
check('percentual 20% sobre 9,50 -> 760', precoDaFaixaEmCentavos({ modo: 'percentual', valor: 20, quantidade_minima: 6 }, 950) === 760);
check('percentual 15% sobre 9,50 arredonda para centavos (807,5 -> 808)', precoDaFaixaEmCentavos({ modo: 'percentual', valor: 15, quantidade_minima: 6 }, 950) === 808);
check('percentual 100% -> 400', !!lanca(() => precoDaFaixaEmCentavos({ modo: 'percentual', valor: 100, quantidade_minima: 6 }, 950)));
check('valor zero -> 400', !!lanca(() => precoDaFaixaEmCentavos({ modo: 'unitario', valor: 0, quantidade_minima: 6 }, 950)));

console.log('\n# validacao das faixas de uma loja');
const f = (q, p, rotulo = '') => ({ quantidade_minima: q, preco_cent: p, rotulo });
check('faixas validas (6 -> 8,00; 24 -> 7,20)', lanca(() => validarFaixasDaLoja([f(6, 800), f(24, 720)], { precoUnitarioCent: 950, custoCent: 500 })) === null);
check('faixa >= preco unitario -> 400', !!lanca(() => validarFaixasDaLoja([f(6, 950)], { precoUnitarioCent: 950, custoCent: 500 })));
check('quantidades repetidas -> 400', !!lanca(() => validarFaixasDaLoja([f(6, 800), f(6, 700)], { precoUnitarioCent: 950, custoCent: 500 })));
check('preco nao decrescente (24 un mais caro que 6 un) -> 400', !!lanca(() => validarFaixasDaLoja([f(6, 800), f(24, 850)], { precoUnitarioCent: 950, custoCent: 500 })));
check('quantidade minima 1 -> 400', !!lanca(() => validarFaixasDaLoja([f(1, 800)], { precoUnitarioCent: 950, custoCent: 500 })));
check('quantidade fracionada -> 400', !!lanca(() => validarFaixasDaLoja([f(2.5, 800)], { precoUnitarioCent: 950, custoCent: 500 })));
const av = validarFaixasDaLoja([f(6, 480)], { precoUnitarioCent: 950, custoCent: 500 });
check('faixa abaixo do custo: so avisa (nao bloqueia)', Array.isArray(av) && av.length === 1 && /custo/.test(av[0]), av);
const av2 = validarFaixasDaLoja([f(6, 540)], { precoUnitarioCent: 950, custoCent: 500 });
check('margem menor que 10%: avisa', av2.length === 1 && /10%/.test(av2[0]), av2);
check('faixa sem aviso quando a margem e boa', validarFaixasDaLoja([f(6, 800)], { precoUnitarioCent: 950, custoCent: 500 }).length === 0);

console.log('\n# qual faixa vale');
const faixas = [
  { id: 'a6', quantidade_minima: 6, preco_cent: 800, automatica: true, rotulo: 'Pack 6' },
  { id: 'a24', quantidade_minima: 24, preco_cent: 720, automatica: true, rotulo: 'Caixa 24' },
  { id: 'm12', quantidade_minima: 12, preco_cent: 760, automatica: false, rotulo: 'Atacado 12' },
];
check('1 un: sem faixa', escolherFaixa(faixas, 1, null) === null);
check('5 un: sem faixa', escolherFaixa(faixas, 5, null) === null);
check('6 un: Pack 6 (automatica)', escolherFaixa(faixas, 6, null).id === 'a6');
check('8 un: Pack 6 vale para TODAS as 8 (8 x 8,00 = 64,00)', (() => { const x = escolherFaixa(faixas, 8, null); return x.id === 'a6' && x.preco_cent * 8 === 6400; })());
check('24 un: a de maior minimo (Caixa 24)', escolherFaixa(faixas, 24, null).id === 'a24');
check('12 un sem faixa_id: a manual NAO aplica (fica o Pack 6)', escolherFaixa(faixas, 12, null).id === 'a6');
check('12 un com faixa manual (7,60) e automatica (8,00): vale a de MENOR preco (manual)', escolherFaixa(faixas, 12, 'm12').id === 'm12');
check('30 un com manual 7,60 e automatica 7,20: vale a de menor preco (automatica), sem empilhar', escolherFaixa(faixas, 30, 'm12').id === 'a24');
const eMan = lanca(() => escolherFaixa(faixas, 8, 'm12'));
check('faixa manual com quantidade abaixo do minimo -> 400', eMan && eMan.status === 400, eMan && eMan.message);
check('faixa_id desconhecida -> 400', !!lanca(() => escolherFaixa(faixas, 8, 'xx')));
check('so faixa manual e nenhuma pedida -> sem desconto', escolherFaixa([faixas[2]], 20, null) === null);

console.log('\n# quantidade somada por produto no documento');
const it = itensParaPreco([
  { product_id: 'p1', quantidade: 4, observacao: 'sem gelo' }, { product_id: 'p1', quantidade: 2, observacao: 'com gelo' },
  { product_id: 'p2', quantidade: 5 },
]);
const p1 = it.find((x) => x.product_id === 'p1'); const p2 = it.find((x) => x.product_id === 'p2');
check('mesmo produto com observacoes diferentes SOMA (4 + 2 = 6)', p1.quantidade === 6);
check('produto diferente nao soma', p2.quantidade === 5);
check('faixa_id da linha acompanha o produto', itensParaPreco([{ product_id: 'p1', quantidade: 3, faixa_id: '11111111-1111-4111-8111-111111111111' }, { product_id: 'p1', quantidade: 3 }])[0].faixa_id === '11111111-1111-4111-8111-111111111111');

console.log(`\nRESULTADO: ${ok} ok, ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);

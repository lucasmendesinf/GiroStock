<?php
/*
 * Motor fiscal do GiroStock (NFC-e, modelo 65) com a NFePHP (sped-nfe). Gratuito e sem intermediario: fala direto com a
 * SEFAZ do estado (Parana: SEFA-PR). Chamado pelo backend Node (services/fiscal.js): recebe um JSON na entrada padrao e
 * devolve um JSON na saida padrao.
 *
 * Acoes:
 *   emitir      monta, assina (com QR Code) e envia a NFC-e; sem conexao com a SEFAZ, emite em contingencia offline
 *   transmitir  envia depois uma NFC-e emitida em contingencia (xml assinado)
 *   cancelar    evento de cancelamento (chave, protocolo, justificativa de 15+ letras)
 *   status      consulta se o servico da SEFAZ esta no ar
 *   certificado le o certificado A1 (.pfx + senha): titular, CNPJ e validade (nao precisa do resto da configuracao)
 *
 * Ambiente: config.tpAmb 2 = homologacao (notas de TESTE, sem valor fiscal), 1 = producao.
 * FISCAL_SIMULADOR=1 (ou entrada.simulador): monta, assina e valida a nota de verdade, mas nao envia (resposta simulada).
 */
error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);
ini_set('display_errors', '0');
require __DIR__ . '/vendor/autoload.php';

use NFePHP\Common\Certificate;
use NFePHP\NFe\Common\Standardize;
use NFePHP\NFe\Complements;
use NFePHP\NFe\Make;
use NFePHP\NFe\Tools;

function responder(array $r): void
{
    echo json_encode($r, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit(0);
}

function num($v, int $casas = 2): string
{
    return number_format((float) $v, $casas, '.', '');
}

function textoNota($t, int $max): string
{
    $t = preg_replace('/\s+/', ' ', trim((string) $t));
    return mb_substr($t, 0, $max, 'UTF-8');
}

const HOMOLOG_ITEM = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
const HOMOLOG_DEST = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

function ferramentas(array $c): Tools
{
    $cfg = [
        'atualizacao' => date('Y-m-d H:i:s'),
        'tpAmb' => (int) $c['tpAmb'],
        'razaosocial' => $c['razao'],
        'siglaUF' => $c['uf'],
        'cnpj' => $c['cnpj'],
        'schemes' => 'PL_010_V1.30',
        'versao' => '4.00',
        'tokenIBPT' => '',
        'CSC' => $c['csc'] ?? '',
        'CSCid' => $c['cscId'] ?? '',
    ];
    // pacote de schemas instalado (o mais novo PL_*) quando o configurado nao existir
    $dir = __DIR__ . '/vendor/nfephp-org/sped-nfe/schemes';
    if (!is_dir($dir . '/' . $cfg['schemes'])) {
        $pls = glob($dir . '/PL_*', GLOB_ONLYDIR) ?: [];
        sort($pls);
        if ($pls) $cfg['schemes'] = basename(end($pls));
    }
    $cert = Certificate::readPfx(base64_decode($c['pfx_b64']), $c['senha']);
    $tools = new Tools(json_encode($cfg), $cert);
    $tools->model('65');
    return $tools;
}

// Monta e assina a NFC-e. Devolve [xmlAssinado, chave].
function montar(Tools $tools, array $c, array $n): array
{
    $hom = (int) $c['tpAmb'] === 2;
    $mk = new Make();
    $inf = new stdClass();
    $inf->versao = '4.00';
    $inf->Id = null;
    $inf->pk_nItem = null;
    $mk->taginfNFe($inf);

    $ide = new stdClass();
    $ide->cUF = (int) $c['cUF'];
    $ide->cNF = str_pad((string) $n['cNF'], 8, '0', STR_PAD_LEFT);
    $ide->natOp = 'VENDA';
    $ide->mod = 65;
    $ide->serie = (int) $n['serie'];
    $ide->nNF = (int) $n['numero'];
    $ide->dhEmi = $n['dhEmi'];
    $ide->dhSaiEnt = null;
    $ide->tpNF = 1;
    $ide->idDest = 1;
    $ide->cMunFG = $c['endereco']['cMun'];
    $ide->tpImp = 4;
    $ide->tpEmis = (int) ($n['tpEmis'] ?? 1);
    $ide->cDV = 0;
    $ide->tpAmb = (int) $c['tpAmb'];
    $ide->finNFe = 1;
    $ide->indFinal = 1;
    $ide->indPres = (int) ($n['indPres'] ?? 1);
    $ide->indIntermed = null;
    $ide->procEmi = 0;
    $ide->verProc = 'GiroStock 1.0';
    if ($ide->tpEmis === 9) {
        $ide->dhCont = $n['dhCont'];
        $ide->xJust = textoNota($n['xJust'] ?? 'Sem comunicacao com a SEFAZ no momento da venda', 256);
    }
    $mk->tagide($ide);

    $em = new stdClass();
    $em->xNome = textoNota($c['razao'], 60);
    $em->xFant = textoNota($c['fantasia'] ?: $c['razao'], 60);
    $em->IE = preg_replace('/\D/', '', $c['ie']);
    $em->CRT = (int) $c['crt'];
    $em->CNPJ = $c['cnpj'];
    $mk->tagemit($em);
    $e = $c['endereco'];
    $end = new stdClass();
    $end->xLgr = textoNota($e['xLgr'], 60);
    $end->nro = textoNota($e['nro'], 60);
    $end->xCpl = !empty($e['xCpl']) ? textoNota($e['xCpl'], 60) : null;
    $end->xBairro = textoNota($e['xBairro'], 60);
    $end->cMun = $e['cMun'];
    $end->xMun = textoNota($e['xMun'], 60);
    $end->UF = $c['uf'];
    $end->CEP = preg_replace('/\D/', '', $e['CEP']);
    $end->cPais = '1058';
    $end->xPais = 'BRASIL';
    $end->fone = !empty($e['fone']) ? preg_replace('/\D/', '', $e['fone']) : null;
    $mk->tagenderEmit($end);

    if (!empty($n['cpf']) || !empty($n['cnpj'])) {
        $d = new stdClass();
        $d->xNome = $hom ? HOMOLOG_DEST : (!empty($n['nome']) ? textoNota($n['nome'], 60) : null);
        if (!empty($n['cpf'])) $d->CPF = preg_replace('/\D/', '', $n['cpf']);
        else $d->CNPJ = preg_replace('/\D/', '', $n['cnpj']);
        $d->indIEDest = 9;
        $mk->tagdest($d);
    }

    foreach ($n['itens'] as $i => $it) {
        $item = $i + 1;
        $p = new stdClass();
        $p->item = $item;
        $p->cProd = textoNota($it['codigo'], 60);
        $ean = preg_replace('/\D/', '', (string) ($it['ean'] ?? ''));
        $p->cEAN = (strlen($ean) >= 8 && $ean[0] !== '2') ? $ean : 'SEM GTIN';   // EAN interno (prefixo 2) nao e GTIN
        $p->cEANTrib = $p->cEAN;
        $p->xProd = ($hom && $item === 1) ? HOMOLOG_ITEM : textoNota($it['nome'], 120);
        $p->NCM = preg_replace('/\D/', '', $it['ncm']);
        $p->CFOP = $it['cfop'];
        $p->uCom = textoNota($it['unidade'], 6);
        $p->qCom = num($it['qtd'], 4);
        $p->vUnCom = num($it['valor_unit'], 10);
        $p->vProd = num($it['total']);
        $p->uTrib = $p->uCom;
        $p->qTrib = $p->qCom;
        $p->vUnTrib = $p->vUnCom;
        $p->vDesc = (float) ($it['desconto'] ?? 0) > 0 ? num($it['desconto']) : null;
        $p->vOutro = (float) ($it['outros'] ?? 0) > 0 ? num($it['outros']) : null;
        $p->vFrete = null;
        $p->vSeg = null;
        $p->indTot = 1;
        $mk->tagprod($p);
        if (!empty($it['cest'])) {
            $ce = new stdClass();
            $ce->item = $item;
            $ce->CEST = preg_replace('/\D/', '', $it['cest']);
            $mk->tagCEST($ce);
        }
        $imp = new stdClass();
        $imp->item = $item;
        $imp->vTotTrib = null;
        $mk->tagimposto($imp);
        $ic = new stdClass();
        $ic->item = $item;
        $ic->orig = (int) ($it['orig'] ?? 0);
        $ic->CSOSN = $it['csosn'];
        $mk->tagICMSSN($ic);
        // Simples Nacional: PIS e COFINS recolhidos no DAS (CST 49/99 com valores zerados)
        $pis = new stdClass();
        $pis->item = $item;
        $pis->CST = $it['cst_pis'] ?? '49';
        $pis->vBC = '0.00';
        $pis->pPIS = '0.0000';
        $pis->vPIS = '0.00';
        $mk->tagPIS($pis);
        $cof = new stdClass();
        $cof->item = $item;
        $cof->CST = $it['cst_cofins'] ?? '49';
        $cof->vBC = '0.00';
        $cof->pCOFINS = '0.0000';
        $cof->vCOFINS = '0.00';
        $mk->tagCOFINS($cof);
    }

    $tr = new stdClass();
    $tr->modFrete = 9;
    $mk->tagtransp($tr);

    $pag = new stdClass();
    $pag->vTroco = (float) ($n['troco'] ?? 0) > 0 ? num($n['troco']) : null;
    $mk->tagpag($pag);
    foreach ($n['pagamentos'] as $pg) {
        $dp = new stdClass();
        $dp->indPag = 0;
        $dp->tPag = $pg['tPag'];
        $dp->xPag = !empty($pg['xPag']) ? textoNota($pg['xPag'], 60) : null;
        $dp->vPag = num($pg['valor']);
        if (in_array($pg['tPag'], ['03', '04', '17'], true)) {
            $dp->tpIntegra = 2;   // maquininha nao integrada ao sistema
        }
        $mk->tagdetPag($dp);
    }

    if (!empty($n['infCpl'])) {
        $ad = new stdClass();
        $ad->infAdFisco = null;
        $ad->infCpl = textoNota($n['infCpl'], 2000);
        $mk->taginfAdic($ad);
    }
    if (!empty($c['respTec']['CNPJ'])) {
        $rt = new stdClass();
        $rt->CNPJ = $c['respTec']['CNPJ'];
        $rt->xContato = textoNota($c['respTec']['xContato'] ?? 'Suporte', 60);
        $rt->email = $c['respTec']['email'] ?? 'suporte@calutec.com.br';
        $rt->fone = preg_replace('/\D/', '', $c['respTec']['fone'] ?? '');
        $mk->taginfRespTec($rt);
    }

    try {
        $xml = $mk->getXML();
    } catch (\Throwable $t) {
        $erros = $mk->getErrors();
        throw new RuntimeException('dados da nota incompletos: ' . ($erros ? implode('; ', $erros) : $t->getMessage()));
    }
    $chave = $mk->getChave();
    $assinado = $tools->signNFe($xml);   // inclui o QR Code (NFC-e) e valida contra o XSD oficial
    return [$assinado, $chave];
}

function suplementos(string $xml): array
{
    $dom = new DOMDocument();
    $dom->loadXML($xml);
    $q = $dom->getElementsByTagName('qrCode')->item(0);
    $u = $dom->getElementsByTagName('urlChave')->item(0);
    return [$q ? trim($q->nodeValue) : null, $u ? trim($u->nodeValue) : null];
}

function semConexao(\Throwable $t): bool
{
    $m = strtolower($t->getMessage());
    foreach (['timed out', 'timeout', 'could not resolve', 'connection', 'connect', 'ssl', 'curl', 'falha de comunica', 'unreachable'] as $s) {
        if (strpos($m, $s) !== false) return true;
    }
    return false;
}

$entrada = json_decode(stream_get_contents(STDIN), true);
if (!is_array($entrada)) responder(['ok' => false, 'situacao' => 'erro', 'motivo' => 'entrada inválida']);
$simulador = getenv('FISCAL_SIMULADOR') === '1' || !empty($entrada['simulador']);
$simular = $entrada['simular'] ?? null;   // so no simulador: 'rejeitar' | 'sem_conexao'
$acao = $entrada['acao'] ?? '';
$c = $entrada['config'] ?? [];

try {
    if ($acao === 'certificado') {
        $cert = Certificate::readPfx(base64_decode($entrada['pfx_b64'] ?? ''), (string) ($entrada['senha'] ?? ''));
        $ate = $cert->getValidTo();
        responder(['ok' => true, 'titular' => $cert->getCompanyName(), 'cnpj' => $cert->getCnpj() ?: null, 'cpf' => $cert->getCpf() ?: null,
            'validade' => $ate ? $ate->format('Y-m-d') : null, 'vencido' => $cert->isExpired()]);
    }
    $tools = ferramentas($c);

    if ($acao === 'status') {
        if ($simulador) responder(['ok' => true, 'cStat' => '107', 'motivo' => 'Servico em Operacao (simulador)']);
        $st = (new Standardize())->toStd($tools->sefazStatus());
        responder(['ok' => (string) $st->cStat === '107', 'cStat' => (string) $st->cStat, 'motivo' => (string) $st->xMotivo]);
    }

    if ($acao === 'emitir' || $acao === 'transmitir') {
        $n = $entrada['nota'] ?? [];
        if ($acao === 'emitir') {
            [$xml, $chave] = montar($tools, $c, $n);
        } else {
            $xml = $entrada['xml'];
            $chave = preg_replace('/\D/', '', (new DOMDocument())->loadXML($xml) ? substr((string) simplexml_load_string($xml)->infNFe['Id'], 3) : '');
        }
        [$qr, $urlChave] = suplementos($xml);
        $emContingencia = $acao === 'emitir' && (int) ($n['tpEmis'] ?? 1) === 9;
        if ($emContingencia) {
            responder(['ok' => true, 'situacao' => 'contingencia', 'cStat' => null, 'motivo' => 'Emitida em contingência offline: será enviada à SEFAZ assim que houver conexão', 'chave' => $chave, 'xml' => $xml, 'qrcode' => $qr, 'url_consulta' => $urlChave]);
        }
        try {
            if ($simulador) {
                if ($simular === 'sem_conexao') throw new RuntimeException('Simulador: falha de comunicação com a SEFAZ (timeout)');
                $cStat = $simular === 'rejeitar' ? '778' : '100';
                $motivo = $simular === 'rejeitar' ? 'Rejeicao: Informado NCM inexistente (simulador)' : 'Autorizado o uso da NF-e';
                $nProt = '141' . date('y') . str_pad((string) random_int(0, 9999999999), 10, '0', STR_PAD_LEFT);
                $prot = '<protNFe versao="4.00"><infProt><tpAmb>' . (int) $c['tpAmb'] . '</tpAmb><verAplic>SIMULADOR</verAplic><chNFe>' . $chave . '</chNFe><dhRecbto>' . date('c') . '</dhRecbto>'
                    . ($cStat === '100' ? '<nProt>' . $nProt . '</nProt>' : '') . '<digVal>x</digVal><cStat>' . $cStat . '</cStat><xMotivo>' . $motivo . '</xMotivo></infProt></protNFe>';
                if ($cStat !== '100') responder(['ok' => false, 'situacao' => 'rejeitada', 'cStat' => $cStat, 'motivo' => $motivo, 'chave' => $chave, 'xml' => $xml]);
                $autorizado = '<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">' . preg_replace('/^<\?xml[^>]*\?>/', '', $xml) . $prot . '</nfeProc>';
                responder(['ok' => true, 'situacao' => 'autorizada', 'cStat' => '100', 'motivo' => $motivo, 'chave' => $chave, 'protocolo' => $nProt, 'xml' => $autorizado, 'qrcode' => $qr, 'url_consulta' => $urlChave]);
            }
            $idLote = str_pad((string) random_int(1, 999999999999999), 15, '0', STR_PAD_LEFT);
            $resp = $tools->sefazEnviaLote([$xml], $idLote, 1);
        } catch (\Throwable $t) {
            if (semConexao($t)) {
                responder(['ok' => false, 'situacao' => 'sem_conexao', 'motivo' => $t->getMessage(), 'chave' => $chave, 'xml' => $xml]);
            }
            throw $t;
        }
        $std = (new Standardize())->toStd($resp);
        $prot = isset($std->protNFe->infProt) ? $std->protNFe->infProt : null;
        $cStat = $prot ? (string) $prot->cStat : (string) $std->cStat;
        $motivo = $prot ? (string) $prot->xMotivo : (string) $std->xMotivo;
        if (in_array($cStat, ['100', '150'], true)) {
            $autorizado = Complements::toAuthorize($xml, $resp);
            responder(['ok' => true, 'situacao' => 'autorizada', 'cStat' => $cStat, 'motivo' => $motivo, 'chave' => $chave, 'protocolo' => (string) $prot->nProt, 'xml' => $autorizado, 'qrcode' => $qr, 'url_consulta' => $urlChave]);
        }
        if ($cStat === '204' || $cStat === '539') {   // ja autorizada (duplicidade): consulta o protocolo
            $cons = (new Standardize())->toStd($tools->sefazConsultaChave($chave));
            if (isset($cons->protNFe->infProt->cStat) && (string) $cons->protNFe->infProt->cStat === '100') {
                responder(['ok' => true, 'situacao' => 'autorizada', 'cStat' => '100', 'motivo' => (string) $cons->protNFe->infProt->xMotivo, 'chave' => $chave, 'protocolo' => (string) $cons->protNFe->infProt->nProt, 'xml' => Complements::toAuthorize($xml, $tools->sefazConsultaChave($chave)), 'qrcode' => $qr, 'url_consulta' => $urlChave]);
            }
        }
        responder(['ok' => false, 'situacao' => 'rejeitada', 'cStat' => $cStat, 'motivo' => $motivo, 'chave' => $chave, 'xml' => $xml]);
    }

    if ($acao === 'cancelar') {
        $just = textoNota($entrada['justificativa'] ?? '', 255);
        if (mb_strlen($just) < 15) responder(['ok' => false, 'situacao' => 'erro', 'motivo' => 'a justificativa do cancelamento precisa ter ao menos 15 letras']);
        if ($simulador) {
            responder(['ok' => true, 'situacao' => 'cancelada', 'cStat' => '135', 'motivo' => 'Evento registrado e vinculado a NF-e (simulador)', 'protocolo' => '141' . date('y') . random_int(1000000000, 9999999999)]);
        }
        $resp = $tools->sefazCancela($entrada['chave'], $just, $entrada['protocolo']);
        $std = (new Standardize())->toStd($resp);
        $inf = $std->retEvento->infEvento ?? null;
        $cStat = $inf ? (string) $inf->cStat : (string) $std->cStat;
        if (in_array($cStat, ['135', '136', '155'], true)) {
            responder(['ok' => true, 'situacao' => 'cancelada', 'cStat' => $cStat, 'motivo' => (string) $inf->xMotivo, 'protocolo' => (string) $inf->nProt, 'xml' => $resp]);
        }
        responder(['ok' => false, 'situacao' => 'rejeitada', 'cStat' => $cStat, 'motivo' => $inf ? (string) $inf->xMotivo : (string) $std->xMotivo]);
    }

    responder(['ok' => false, 'situacao' => 'erro', 'motivo' => 'ação desconhecida']);
} catch (\Throwable $t) {
    responder(['ok' => false, 'situacao' => 'erro', 'motivo' => $t->getMessage()]);
}

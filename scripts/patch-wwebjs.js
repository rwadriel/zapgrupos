// Correção pontual no whatsapp-web.js enquanto o upstream não publica a sua.
//
// Desde ~17/09/2026 o WhatsApp Web valida o id da mensagem na hora do envio.
// O resultado de processMediaData() é um model com o campo interno __x_id, e o
// sendMessage da lib espalha esse model dentro da mensagem — o __x_id acaba
// sobrescrevendo o id real e o envio estoura:
//   "Data passed to getter must include an id property (it's how we memoize)"
// Só mensagens com mídia são afetadas. Mesma correção do PR #201923 do
// wwebjs/whatsapp-web.js (issue #201922), mais a restauração explícita do id.
//
// Roda no build do Docker, depois do npm ci. É idempotente e, se a lib mudar
// (ex.: o upstream corrigir), só avisa e não quebra o build.
const fs = require('fs');
const path = require('path');

const ARQ = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
const MARCA = 'ZG-PATCH midia __x_id';
const ANCORA = "        // Bot's won't reply if canonicalUrl is set (linking)";

let src;
try { src = fs.readFileSync(ARQ, 'utf8'); }
catch (e) { console.warn('[patch-wwebjs] lib não encontrada, nada a fazer:', e.message); process.exit(0); }

if (src.includes(MARCA)) { console.log('[patch-wwebjs] correção de mídia já aplicada.'); process.exit(0); }

const ocorrencias = src.split(ANCORA).length - 1;
if (ocorrencias !== 1) {
  console.warn(`[patch-wwebjs] ATENÇÃO: ponto de inserção encontrado ${ocorrencias}x (esperado 1). ` +
    'A lib mudou — revisar se o upstream já corrigiu o envio de mídia. Patch NÃO aplicado.');
  process.exit(0);
}

const correcao =
  `        // ${MARCA}: o model de mídia espalhado acima traz __x_id, que\n` +
  `        // sobrescreve o id da mensagem e quebra o envio no WhatsApp Web atual.\n` +
  `        delete message.__x_id;\n` +
  `        message.id = newMsgKey;\n\n`;

fs.writeFileSync(ARQ, src.replace(ANCORA, correcao + ANCORA));
console.log('[patch-wwebjs] correção de mídia aplicada.');

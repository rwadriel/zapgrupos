// sender.js — motor de envio com simulação de comportamento humano
const fs = require('fs');
const { MessageMedia, Poll } = require('whatsapp-web.js');
const { client, state } = require('./wa');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

// Teto de tempo para o envio a UM grupo. Se o WhatsApp Web travar (já
// aconteceu: chamada do Puppeteer pendurada por 35min segurou a fila
// inteira), o envio daquele grupo falha e a fila segue em frente.
// A simulação humana usa no máximo ~25s de "digitando", então 4min é folga.
const TIMEOUT_ENVIO_MS = Math.max(1, Number(process.env.ZG_TIMEOUT_ENVIO_MINUTOS) || 4) * 60000;

function comTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Envio travou e foi abortado após ${Math.round(ms / 60000)}min.`)), ms);
    promise.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); }
    );
  });
}

// Carrega a mídia com erro legível. Se o arquivo sumiu do disco (volume
// /app/media não montado, arquivo apagado), o whatsapp-web.js estoura um
// ENOENT cru — que não diz ao usuário o que fazer. Campanhas são o caso
// típico: elas reaproveitam arquivos enviados dias antes.
function carregarMidia(filePath, fileName) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Arquivo não encontrado no servidor: ${fileName || filePath}. Reenvie a mídia (na etapa da campanha, se for campanha). Se isso se repetir após cada deploy, a pasta /app/media não está como volume permanente.`);
  }
  return MessageMedia.fromFilePath(filePath);
}

function typingMs(text) {
  const base = (text || '').length * jitter(45, 75);
  return Math.min(Math.max(base, 2000), 25000);
}

function recordingMs(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    return Math.min(Math.max(Math.round(size / 2000) * 1000, 4000), 25000);
  } catch {
    return jitter(5000, 12000);
  }
}

// Presença ("digitando…"/"gravando…") sem passar pelo getChatById (que quebra
// no getChatModel). Chama direto o WWebJS.sendChatstate com o id do grupo.
// Best-effort: se falhar, apenas não mostra o indicador — não impede o envio.
async function setPresence(groupId, estado) {
  try {
    await client.pupPage.evaluate((s, id) => window.WWebJS.sendChatstate(s, id), estado, groupId);
  } catch (e) { /* presença é só cosmética */ }
}

// Participantes do grupo para "mencionar todos", lidos direto da página (sem
// getChatModel, que está quebrado). Retorna [] se não conseguir — nesse caso
// a mensagem é enviada sem menções, em vez de falhar.
async function getMentionsForAll(groupId) {
  try {
    const ids = await client.pupPage.evaluate((gid) => {
      let chat = null;
      try { chat = window.require('WAWebCollections').Chat.get(gid); } catch (e) { return []; }
      const parts = chat && chat.groupMetadata && chat.groupMetadata.participants;
      const arr = parts && (parts.getModelsArray ? parts.getModelsArray() : (Array.isArray(parts) ? parts : null));
      if (!arr) return [];
      return arr.map(p => (p && p.id && p.id._serialized) || null).filter(Boolean);
    }, groupId);
    const myId = client.info?.wid?._serialized;
    return [...new Set(ids.filter(id => (id.endsWith('@c.us') || id.endsWith('@lid')) && id !== myId))];
  } catch (e) {
    return [];
  }
}

// Diagnóstico da prévia de link (aquele cartão com imagem/título).
// A lib já pede prévia por padrão, chamando a API interna do WhatsApp Web —
// e a própria doc dela avisa que isso "não tem efeito em contas
// multi-dispositivo". Como o link está indo seco, este teste mostra no log o
// que a API responde de fato neste ambiente. É só observação: roda em
// try/catch e nunca altera nem bloqueia o envio.
async function diagnosticarPreviaDeLink(texto) {
  if (!texto || !/https?:\/\//i.test(texto)) return;
  try {
    const r = await client.pupPage.evaluate(async (t) => {
      let link = null;
      try {
        const { findLink } = window.require('WALinkify');
        link = findLink(t);
      } catch (e) { return { etapa: 'WALinkify', erro: String(e && e.message || e) }; }
      if (!link) return { etapa: 'findLink', resultado: 'nenhum link reconhecido' };
      try {
        const p = await window.require('WAWebLinkPreviewChatAction').getLinkPreview(link);
        return {
          etapa: 'getLinkPreview',
          link: String(link.href || link),
          respostaVazia: !p,
          temData: !!(p && p.data),
          campos: p && p.data ? Object.keys(p.data).slice(0, 12) : (p ? Object.keys(p).slice(0, 12) : null)
        };
      } catch (e) { return { etapa: 'getLinkPreview', erro: String(e && e.message || e) }; }
    }, texto);
    console.log('[Prévia de link]', JSON.stringify(r));
  } catch (e) {
    console.log('[Prévia de link] diagnóstico falhou:', e.message);
  }
}

async function buildSendOptions(job, groupId) {
  const options = { waitUntilMsgSent: true };

  if (job.mentionAll) {
    const mentions = await getMentionsForAll(groupId);
    if (mentions.length) options.mentions = mentions;
  }

  return options;
}

async function sendToGroup(job, groupId) {
  if (state.status !== 'conectado') {
    throw new Error('WhatsApp não está conectado');
  }

  // Usa client.sendMessage(id, ...) em vez de getChatById().sendMessage():
  // internamente ele resolve a conversa com getAsModel:false, pulando o
  // getChatModel do whatsapp-web.js (que está estourando "r" com o WhatsApp
  // Web atual). O envio em si é idêntico.
  const humanize = job.humanize !== false;
  const options = await buildSendOptions(job, groupId);

  switch (job.type) {
    case 'texto': {
      if (humanize) {
        await setPresence(groupId, 'typing');
        await sleep(typingMs(job.text));
        await setPresence(groupId, 'stop');
      }
      await diagnosticarPreviaDeLink(job.text);
      await client.sendMessage(groupId, job.text, options);
      break;
    }

    case 'midia': {
      // Uma mensagem pode ter vários arquivos (fotos/vídeos misturados):
      // envia um por um, legenda e menções só no primeiro.
      const files = (job.files && job.files.length)
        ? job.files
        : [{ filePath: job.filePath, fileName: job.fileName }];
      for (let i = 0; i < files.length; i++) {
        const media = carregarMidia(files[i].filePath, files[i].fileName);
        if (i === 0 && humanize && job.caption) {
          await setPresence(groupId, 'typing');
          await sleep(typingMs(job.caption));
          await setPresence(groupId, 'stop');
        } else if (humanize) {
          await sleep(jitter(1500, 4000));
        }
        const opts = i === 0 ? { ...options, caption: job.caption || undefined } : { waitUntilMsgSent: true };
        await client.sendMessage(groupId, media, opts);
      }
      break;
    }

    case 'audio': {
      const media = carregarMidia(job.filePath, job.fileName);
      if (humanize) {
        await setPresence(groupId, 'recording');
        await sleep(recordingMs(job.filePath));
        await setPresence(groupId, 'stop');
      }
      await client.sendMessage(groupId, media, { ...options, sendAudioAsVoice: true });
      break;
    }

    case 'enquete': {
      if (humanize) {
        await setPresence(groupId, 'typing');
        await sleep(typingMs(job.pollQuestion + (job.pollOptions || []).join('')));
        await setPresence(groupId, 'stop');
      }
      const poll = new Poll(job.pollQuestion, job.pollOptions, {
        allowMultipleAnswers: !!job.allowMultiple
      });
      await client.sendMessage(groupId, poll, options);
      break;
    }

    default:
      throw new Error(`Tipo de mensagem desconhecido: ${job.type}`);
  }
}

async function runJob(job, onProgress) {
  const results = [];
  // Mensagens com vários arquivos demoram mais: o teto cresce junto.
  const nFiles = (job.files && job.files.length) || 1;
  const timeoutMs = TIMEOUT_ENVIO_MS * nFiles;
  for (let i = 0; i < job.groupIds.length; i++) {
    const groupId = job.groupIds[i];
    try {
      await comTimeout(sendToGroup(job, groupId), timeoutMs);
      results.push({ groupId, ok: true, at: new Date().toISOString() });
    } catch (e) {
      results.push({ groupId, ok: false, error: e.message, at: new Date().toISOString() });
    }
    if (onProgress) onProgress(results);
    if (i < job.groupIds.length - 1 && job.humanize !== false) {
      await sleep(jitter(8000, 20000));
    }
  }
  return results;
}

module.exports = { runJob };

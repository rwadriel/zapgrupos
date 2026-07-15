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

function normalizeMentionId(participant) {
  const raw = participant?.id?._serialized || participant?.id || participant?._serialized || '';
  if (!raw || typeof raw !== 'string') return null;
  if (!raw.endsWith('@c.us') && !raw.endsWith('@lid')) return null;
  return raw;
}

async function getMentionsForAll(chat) {
  if (!chat || !chat.isGroup || !Array.isArray(chat.participants)) return [];

  const myId = client.info?.wid?._serialized;
  const mentions = chat.participants
    .map(normalizeMentionId)
    .filter(Boolean)
    .filter(id => id !== myId);

  return [...new Set(mentions)];
}

async function buildSendOptions(job, chat) {
  const options = { waitUntilMsgSent: true };

  if (job.mentionAll && chat.isGroup) {
    const mentions = await getMentionsForAll(chat);
    if (mentions.length) options.mentions = mentions;
  }

  return options;
}

async function sendToGroup(job, groupId) {
  if (state.status !== 'conectado') {
    throw new Error('WhatsApp não está conectado');
  }

  const chat = await client.getChatById(groupId);
  const humanize = job.humanize !== false;
  const options = await buildSendOptions(job, chat);

  switch (job.type) {
    case 'texto': {
      if (humanize) {
        await chat.sendStateTyping();
        await sleep(typingMs(job.text));
        await chat.clearState();
      }
      await chat.sendMessage(job.text, options);
      break;
    }

    case 'midia': {
      // Uma mensagem pode ter vários arquivos (fotos/vídeos misturados):
      // envia um por um, legenda e menções só no primeiro.
      const files = (job.files && job.files.length)
        ? job.files
        : [{ filePath: job.filePath, fileName: job.fileName }];
      for (let i = 0; i < files.length; i++) {
        const media = MessageMedia.fromFilePath(files[i].filePath);
        if (i === 0 && humanize && job.caption) {
          await chat.sendStateTyping();
          await sleep(typingMs(job.caption));
          await chat.clearState();
        } else if (humanize) {
          await sleep(jitter(1500, 4000));
        }
        const opts = i === 0 ? { ...options, caption: job.caption || undefined } : { waitUntilMsgSent: true };
        await chat.sendMessage(media, opts);
      }
      break;
    }

    case 'audio': {
      const media = MessageMedia.fromFilePath(job.filePath);
      if (humanize) {
        await chat.sendStateRecording();
        await sleep(recordingMs(job.filePath));
        await chat.clearState();
      }
      await chat.sendMessage(media, { ...options, sendAudioAsVoice: true });
      break;
    }

    case 'enquete': {
      if (humanize) {
        await chat.sendStateTyping();
        await sleep(typingMs(job.pollQuestion + (job.pollOptions || []).join('')));
        await chat.clearState();
      }
      const poll = new Poll(job.pollQuestion, job.pollOptions, {
        allowMultipleAnswers: !!job.allowMultiple
      });
      await chat.sendMessage(poll, options);
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

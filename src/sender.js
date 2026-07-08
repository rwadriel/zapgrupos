// sender.js — motor de envio com simulação de comportamento humano

const fs = require('fs');
const { MessageMedia, Poll } = require('whatsapp-web.js');
const { client, state } = require('./wa');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

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

function cleanMentionToken(id) {
  return String(id || '')
    .replace('@c.us', '')
    .replace('@s.whatsapp.net', '')
    .replace('@lid', '')
    .trim();
}

async function buildMentionAll(chat) {
  if (!chat || !chat.isGroup || !Array.isArray(chat.participants)) {
    return { mentions: [], text: '' };
  }

  const myId = client.info?.wid?._serialized;

  const mentions = chat.participants
    .map(p => p?.id?._serialized)
    .filter(Boolean)
    .filter(id => id !== myId);

  const text = mentions
    .map(id => cleanMentionToken(id))
    .filter(Boolean)
    .map(n => `@${n}`)
    .join(' ');

  return { mentions, text };
}

function appendMentionsToText(originalText, mentionData) {
  const base = String(originalText || '').trim();

  if (!mentionData || !mentionData.mentions.length || !mentionData.text) {
    return base;
  }

  return `${base}\n\n${mentionData.text}`;
}

async function sendMentionOnly(chat, mentionData) {
  if (!mentionData || !mentionData.mentions.length || !mentionData.text) return;

  await chat.sendMessage(mentionData.text, {
    mentions: mentionData.mentions
  });
}

async function sendToGroup(job, groupId) {
  if (state.status !== 'conectado') {
    throw new Error('WhatsApp não está conectado');
  }

  const chat = await client.getChatById(groupId);
  const humanize = job.humanize !== false;

  const mentionData = job.mentionAll && chat.isGroup
    ? await buildMentionAll(chat)
    : { mentions: [], text: '' };

  const mentionOptions = mentionData.mentions.length
    ? { mentions: mentionData.mentions }
    : {};

  switch (job.type) {
    case 'texto': {
      const finalText = appendMentionsToText(job.text, mentionData);

      if (humanize) {
        await chat.sendStateTyping();
        await sleep(typingMs(finalText));
        await chat.clearState();
      }

      await chat.sendMessage(finalText, mentionOptions);
      break;
    }

    case 'midia': {
      const media = MessageMedia.fromFilePath(job.filePath);
      const finalCaption = appendMentionsToText(job.caption || '', mentionData);

      if (humanize && finalCaption) {
        await chat.sendStateTyping();
        await sleep(typingMs(finalCaption));
        await chat.clearState();
      } else if (humanize) {
        await sleep(jitter(1500, 4000));
      }

      await chat.sendMessage(media, {
        ...mentionOptions,
        caption: finalCaption || undefined
      });

      break;
    }

    case 'audio': {
      const media = MessageMedia.fromFilePath(job.filePath);

      if (humanize) {
        await chat.sendStateRecording();
        await sleep(recordingMs(job.filePath));
        await chat.clearState();
      }

      await chat.sendMessage(media, {
        sendAudioAsVoice: true
      });

      // Áudio não tem texto/caption confiável para mencionar.
      // Por isso enviamos uma segunda mensagem só com as menções.
      if (mentionData.mentions.length) {
        await sleep(jitter(1200, 2500));
        await sendMentionOnly(chat, mentionData);
      }

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

      await chat.sendMessage(poll);

      // Enquete também não é texto comum, então a menção vai separada.
      if (mentionData.mentions.length) {
        await sleep(jitter(1200, 2500));
        await sendMentionOnly(chat, mentionData);
      }

      break;
    }

    default:
      throw new Error(`Tipo de mensagem desconhecido: ${job.type}`);
  }
}

async function runJob(job, onProgress) {
  const results = [];

  for (let i = 0; i < job.groupIds.length; i++) {
    const groupId = job.groupIds[i];

    try {
      await sendToGroup(job, groupId);
      results.push({
        groupId,
        ok: true,
        at: new Date().toISOString()
      });
    } catch (e) {
      results.push({
        groupId,
        ok: false,
        error: e.message,
        at: new Date().toISOString()
      });
    }

    if (onProgress) onProgress(results);

    if (i < job.groupIds.length - 1 && job.humanize !== false) {
      await sleep(jitter(8000, 20000));
    }
  }

  return results;
}

module.exports = {
  runJob
};

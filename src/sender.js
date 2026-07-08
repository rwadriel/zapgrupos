// sender.js — motor de envio com simulação de comportamento humano
const fs = require('fs');
const { MessageMedia, Poll } = require('whatsapp-web.js');
const { client, state } = require('./wa');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

// Tempo de "digitando..." proporcional ao texto (~ digitação humana), entre 2s e 25s
function typingMs(text) {
  const base = (text || '').length * jitter(45, 75);
  return Math.min(Math.max(base, 2000), 25000);
}

// Tempo de "gravando áudio..." estimado pelo tamanho do arquivo (opus ~2 KB/s), entre 4s e 25s
function recordingMs(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    return Math.min(Math.max(Math.round(size / 2000) * 1000, 4000), 25000);
  } catch {
    return jitter(5000, 12000);
  }
}

async function getMentionsForAll(chat) {
  // Menção invisível: todos os participantes recebem a notificação de menção,
  // mas o texto da mensagem permanece limpo (sem centenas de @).
  return chat.participants.map(p => p.id._serialized);
}

/**
 * Envia o conteúdo de um job para UM grupo, com simulação humana opcional.
 * job.type: 'texto' | 'midia' | 'audio' | 'enquete'
 */
async function sendToGroup(job, groupId) {
  if (state.status !== 'conectado') {
    throw new Error('WhatsApp não está conectado');
  }

  const chat = await client.getChatById(groupId);
  const humanize = job.humanize !== false;
  const options = {};

  if (job.mentionAll && chat.isGroup) {
    options.mentions = await getMentionsForAll(chat);
  }

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
      // imagem ou vídeo, com legenda opcional
      const media = MessageMedia.fromFilePath(job.filePath);
      if (humanize && job.caption) {
        await chat.sendStateTyping();
        await sleep(typingMs(job.caption));
        await chat.clearState();
      } else if (humanize) {
        await sleep(jitter(1500, 4000));
      }
      await chat.sendMessage(media, { ...options, caption: job.caption || undefined });
      break;
    }

    case 'audio': {
      // Enviado como PTT (nota de voz) — aparece como se tivesse sido gravado na hora,
      // precedido do status "gravando áudio..." no grupo.
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

/**
 * Executa um job em todos os grupos selecionados, com intervalo aleatório
 * entre grupos (8–20s) para não parecer disparo automatizado.
 * Retorna o relatório por grupo.
 */
async function runJob(job, onProgress) {
  const results = [];
  for (let i = 0; i < job.groupIds.length; i++) {
    const groupId = job.groupIds[i];
    try {
      await sendToGroup(job, groupId);
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

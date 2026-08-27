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

// ===== Prévia de link com imagem =====
// A prévia da lib já traz título/descrição (vem do getLinkPreview do WhatsApp
// Web), mas SEM a imagem — por isso o cartão ia "pela metade". O WhatsApp
// exige a miniatura embutida no campo jpegThumbnail; o cliente oficial baixa
// a imagem e anexa, passo que a lib não faz. Aqui buscamos a og:image do site
// e geramos essa miniatura.
//
// Vai em options.extraOptions porque a lib espalha extraOptions POR ÚLTIMO ao
// montar a mensagem — assim a miniatura não é sobrescrita pela prévia dela.
// Tudo best-effort: qualquer falha volta ao comportamento atual (cartão sem
// imagem), nunca impede o envio.
const UA_NAVEGADOR = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PREVIA_LARGURA_MAX = 640;

function primeiroLink(texto) {
  const m = String(texto || '').match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[.,;:!?)\]]+$/, '') : null;
}

function extrairOgImage(html, baseUrl) {
  // procura og:image e, como reserva, twitter:image (com atributos em qualquer ordem)
  const padroes = [
    /<meta[^>]+(?:property|name)=["']og:image(?::secure_url|:url)?["'][^>]*>/gi,
    /<meta[^>]+(?:property|name)=["']twitter:image(?::src)?["'][^>]*>/gi
  ];
  for (const re of padroes) {
    const tags = html.match(re);
    if (!tags) continue;
    for (const tag of tags) {
      const c = tag.match(/content=["']([^"']+)["']/i);
      if (c && c[1]) {
        try { return new URL(c[1], baseUrl).href; } catch { /* url inválida */ }
      }
    }
  }
  return null;
}

async function buscarUrlDaImagem(link) {
  const res = await fetch(link, {
    headers: { 'User-Agent': UA_NAVEGADOR, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return null;
  if (!/text\/html/i.test(res.headers.get('content-type') || '')) return null;
  const html = (await res.text()).slice(0, 400000); // og:* fica no <head>
  return extrairOgImage(html, res.url || link);
}

async function baixarImagemComoDataUrl(urlImagem) {
  const res = await fetch(urlImagem, {
    headers: { 'User-Agent': UA_NAVEGADOR, Accept: 'image/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return null;
  const tipo = res.headers.get('content-type') || 'image/jpeg';
  if (!/^image\//i.test(tipo)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
  return `data:${tipo};base64,${buf.toString('base64')}`;
}

// Redimensiona e converte para JPEG usando o canvas da própria página (evita
// depender de biblioteca nativa de imagem no servidor).
async function gerarMiniatura(dataUrl) {
  return await client.pupPage.evaluate(async (src, maxW) => {
    const img = new Image();
    await new Promise((ok, falha) => {
      img.onload = ok;
      img.onerror = () => falha(new Error('imagem não decodificou'));
      img.src = src;
    });
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('imagem sem dimensões');
    const escala = Math.min(1, maxW / w);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * escala));
    c.height = Math.max(1, Math.round(h * escala));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72).split(',')[1];
  }, dataUrl, PREVIA_LARGURA_MAX);
}

// Quanto esperar a prévia carregar antes de enviar — o mesmo que uma pessoa
// faz: cola o link, vê o cartão montar e só então aperta enviar. O WhatsApp
// devolve título/descrição na hora, mas a IMAGEM chega depois; enviar no
// mesmo instante manda o cartão sem foto.
const ESPERA_PREVIA_MS = Math.max(0, Number(process.env.ZG_ESPERA_PREVIA_SEGUNDOS) || 12) * 1000;

// A prévia fica em cache na página do WhatsApp. Numa mensagem para vários
// grupos, só o primeiro precisa esperar a imagem carregar; os seguintes já
// pegam pronto. Sem isto, cada grupo somaria +12s à fila à toa.
const linksAquecidos = new Map();
const VALIDADE_AQUECIMENTO_MS = 5 * 60000;

function jaAquecido(link) {
  const t = linksAquecidos.get(link);
  if (t && Date.now() - t < VALIDADE_AQUECIMENTO_MS) return true;
  linksAquecidos.set(link, Date.now());
  // limpeza simples para o mapa não crescer sem limite
  if (linksAquecidos.size > 200) {
    for (const [k, v] of linksAquecidos) if (Date.now() - v > VALIDADE_AQUECIMENTO_MS) linksAquecidos.delete(k);
  }
  return false;
}

// Pede a prévia ao WhatsApp Web (aquece o cache dele, como colar no campo de
// digitação) e conta o que veio. Só observa — nunca interrompe o envio.
async function consultarPrevia(texto) {
  try {
    return await client.pupPage.evaluate(async (t) => {
      let link = null;
      try {
        const { findLink } = window.require('WALinkify');
        link = findLink(t);
      } catch (e) { return { erro: 'WALinkify: ' + (e && e.message) }; }
      if (!link) return { semLink: true };
      try {
        const p = await window.require('WAWebLinkPreviewChatAction').getLinkPreview(link);
        const d = (p && p.data) || p || null;
        const campos = d ? Object.keys(d) : [];
        return {
          campos,
          // algum campo de imagem? (thumbnail, jpegThumbnail, imageUrl...)
          temImagem: campos.some(k => /thumb|image/i.test(k) && d[k]),
          vazio: !d
        };
      } catch (e) { return { erro: 'getLinkPreview: ' + (e && e.message) }; }
    }, texto);
  } catch (e) {
    return { erro: e.message };
  }
}

async function miniaturaDoLink(texto) {
  const link = primeiroLink(texto);
  if (!link) return null;
  try {
    const urlImagem = await buscarUrlDaImagem(link);
    if (!urlImagem) {
      console.log('[Prévia de link] sem og:image em', link);
      return null;
    }
    const dataUrl = await baixarImagemComoDataUrl(urlImagem);
    if (!dataUrl) {
      console.log('[Prévia de link] não baixou a imagem:', urlImagem);
      return null;
    }
    const jpeg = await gerarMiniatura(dataUrl);
    if (!jpeg) return null;
    console.log(`[Prévia de link] miniatura pronta para ${link} (${Math.round(jpeg.length / 1024)}KB)`);
    return jpeg;
  } catch (e) {
    console.log('[Prévia de link] falhou (envia sem imagem):', e.message);
    return null;
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
      const link = primeiroLink(job.text);

      // 1) Dispara a busca da prévia ANTES da espera — é o equivalente a colar
      //    o link no campo de digitação e deixar o WhatsApp trabalhar.
      const antes = link ? await consultarPrevia(job.text) : null;

      // 2) Espera. Com "simular envio" ligado, o tempo de "digitando..." já
      //    serve; se for curto demais para a imagem carregar, completamos.
      let esperou = 0;
      if (humanize) {
        await setPresence(groupId, 'typing');
        const t = typingMs(job.text);
        await sleep(t);
        esperou = t;
        await setPresence(groupId, 'stop');
      }
      // Só o primeiro envio deste link paga a espera cheia.
      const precisaEsperar = link && !jaAquecido(link);
      if (precisaEsperar && esperou < ESPERA_PREVIA_MS) await sleep(ESPERA_PREVIA_MS - esperou);

      // 3) Confere se a imagem já chegou. Se o próprio WhatsApp tem a imagem,
      //    deixamos a prévia dele; se não, anexamos a miniatura da og:image.
      let extras = null;
      if (link) {
        const depois = await consultarPrevia(job.text);
        console.log('[Prévia de link]', JSON.stringify({ antes, depois }));
        if (!depois || !depois.temImagem) {
          const jpegThumbnail = await miniaturaDoLink(job.text);
          if (jpegThumbnail) extras = { extraOptions: { jpegThumbnail } };
        }
      }

      await client.sendMessage(groupId, job.text, extras ? { ...options, ...extras } : options);
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

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');

console.log('[WA] VERSAO DEFINITIVA: Google Chrome Stable, sem userDataDir, sem single-process, sem crashpad');

const state = {
  status: 'iniciando',
  qrDataUrl: null,
  me: null,
  lastError: null
};

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, '..', '.wwebjs_auth')
  }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
    timeout: 90000,
    protocolTimeout: 90000,
    // false = não despeja o stderr do Chrome no log (ALSA, GCM DEPRECATED_ENDPOINT,
    // machine-id etc. são ruído de container sem áudio/dbus, não são erros reais).
    // Volte para true se precisar depurar o Chrome em si.
    dumpio: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-popup-blocking',
      '--disable-translate',
      '--disable-crash-reporter',
      '--disable-crashpad',
      '--disable-breakpad',
      '--no-crash-upload',
      '--noerrdialogs',
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--use-mock-keychain',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--window-size=1280,720'
    ]
  }
});

client.on('qr', async (qr) => {
  state.status = 'aguardando_qr';
  state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
  state.lastError = null;
  console.log('[WA] QR code gerado — escaneie na aba Conexão.');
});

client.on('authenticated', () => {
  state.status = 'autenticando';
  state.qrDataUrl = null;
  state.lastError = null;
  console.log('[WA] Autenticado, carregando sessão...');
});

client.on('ready', () => {
  state.status = 'conectado';
  state.qrDataUrl = null;
  state.lastError = null;

  state.me = {
    name: client.info?.pushname || 'WhatsApp',
    number: client.info?.wid?.user || ''
  };

  console.log(`[WA] Conectado como ${state.me.name} (${state.me.number}).`);
  console.log('[WA] Sincronizando conversas... aguarde alguns segundos e clique em "recarregar".');
});

client.on('disconnected', (reason) => {
  state.status = 'desconectado';
  state.me = null;
  state.qrDataUrl = null;
  state.lastError = String(reason);
  console.log('[WA] Desconectado:', reason);

  setTimeout(() => {
    initialize();
  }, 5000);
});

client.on('auth_failure', (msg) => {
  state.status = 'desconectado';
  state.qrDataUrl = null;
  state.me = null;
  state.lastError = 'Falha de autenticação: ' + msg;
  console.error('[WA] Falha de autenticação:', msg);
});

let retryTimer = null;

function initialize() {
  console.log('[WA] Inicializando WhatsApp...');
  state.status = 'iniciando';
  state.lastError = null;

  client.initialize().catch(e => {
    state.status = 'desconectado';
    state.qrDataUrl = null;
    state.me = null;
    state.lastError = e.message;
    console.error('[WA] Erro ao inicializar:', e.message);

    // Sem isto, uma falha na inicialização (Chrome engasgado, rede fora)
    // deixava o sistema "desconectado" para sempre, até reiniciar na mão.
    clearTimeout(retryTimer);
    retryTimer = setTimeout(initialize, 30000);
    console.log('[WA] Nova tentativa de conexão em 30s.');
  });
}

// Teto de tempo para a listagem: getChats() às vezes trava (bug do Puppeteer)
// e, sem isto, o /api/groups fica pendurado para sempre — o painel espera sem
// mostrar grupo nem erro. O teto força a falha para virar um erro visível.
const LISTAR_TIMEOUT_MS = 25000;

function comTimeout(promise, ms, oque) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${oque} travou (timeout ${ms / 1000}s)`)), ms))
  ]);
}

// Leitura resiliente dos grupos, direto do WhatsApp Web, SEM passar pelo
// getChatModel() do whatsapp-web.js. Na versão atual da lib, o getChats() monta
// cada conversa e faz a migração LID/toPn dos participantes; quando o WhatsApp
// Web muda algo, isso lança um erro minificado ("r") e o Promise.all derruba a
// lista inteira. Aqui pegamos só o essencial (id, nome, nº de participantes) e
// ignoramos qualquer conversa que dê erro, em vez de perder todos os grupos.
async function listGroupsResiliente() {
  return await client.pupPage.evaluate(() => {
    let ChatCol = null;
    try { ChatCol = window.require('WAWebCollections').Chat; } catch (e) { ChatCol = null; }
    if (!ChatCol || !ChatCol.getModelsArray) return { erro: 'sem_collection', total: 0, grupos: [] };

    const chats = ChatCol.getModelsArray();
    const grupos = [];

    for (const chat of chats) {
      try {
        const id = chat && chat.id && chat.id._serialized;
        if (!id || id.slice(-5) !== '@g.us') continue;

        let name = '(grupo sem nome)';
        try {
          name = chat.formattedTitle
            || (chat.groupMetadata && chat.groupMetadata.subject)
            || chat.name || name;
        } catch (e) {}

        let participants = null;
        try {
          const parts = chat.groupMetadata && chat.groupMetadata.participants;
          if (parts) {
            const arr = parts.getModelsArray ? parts.getModelsArray()
              : (typeof parts.length === 'number' ? parts : null);
            if (arr) participants = arr.length;
          }
        } catch (e) {}

        grupos.push({ id, name, participants, isAdmin: false });
      } catch (e) { /* pula esta conversa e segue */ }
    }

    return { erro: null, total: chats.length, grupos };
  });
}

let listandoGrupos = false;
let ultimosGrupos = [];

async function listGroups() {
  if (state.status !== 'conectado') {
    console.log('[Grupos] Ignorado: status =', state.status);
    return [];
  }

  // O painel faz polling a cada 3s; enquanto uma listagem está em andamento,
  // devolve o último resultado bom em vez de empilhar chamadas ao getChats.
  if (listandoGrupos) return ultimosGrupos;
  listandoGrupos = true;

  try {
    // 1) Caminho principal: leitura resiliente (não quebra por 1 conversa ruim).
    try {
      const r = await comTimeout(listGroupsResiliente(), LISTAR_TIMEOUT_MS, 'getChats');
      if (r && !r.erro) {
        console.log(`[Grupos] Resiliente: ${r.total} conversa(s), ${r.grupos.length} grupo(s).`);
        if (r.grupos.length) {
          ultimosGrupos = r.grupos.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
          return ultimosGrupos;
        }
      } else {
        console.log('[Grupos] Resiliente indisponível:', (r && r.erro) || 'desconhecido');
      }
    } catch (e) {
      console.log('[Grupos] Leitura resiliente falhou:', (e && e.message) || e);
    }

    // 2) Fallback: método original da biblioteca (pode falhar igual, mas não regride).
    let chats = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        chats = await comTimeout(client.getChats(), LISTAR_TIMEOUT_MS, 'getChats');
      } catch (e) {
        console.log(`[Grupos] Fallback tentativa ${attempt} falhou: ${(e && e.name) || 'Erro'}: ${e && e.message}`);
        if (attempt < 3) { await new Promise(r => setTimeout(r, 4000)); continue; }
        throw new Error('Não consegui ler os grupos do WhatsApp. Clique em "recarregar"; se persistir, reinicie o app.');
      }
      const groupCount = chats.filter(c => c.isGroup).length;
      console.log(`[Grupos] Fallback tentativa ${attempt}: ${chats.length} conversa(s), ${groupCount} grupo(s).`);
      if (groupCount > 0) break;
      if (attempt < 3) await new Promise(r => setTimeout(r, 4000));
    }

    ultimosGrupos = chats
    .filter(c => c.isGroup)
    .map(c => ({
      id: c.id._serialized,
      name: c.name || '(grupo sem nome)',
      participants: c.participants ? c.participants.length : null,
      isAdmin: c.participants
        ? c.participants.some(p =>
            p.id._serialized === client.info.wid._serialized &&
            (p.isAdmin || p.isSuperAdmin)
          )
        : false
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    return ultimosGrupos;
  } finally {
    listandoGrupos = false;
  }
}

async function logout() {
  try {
    await client.logout();
  } catch {}

  state.status = 'desconectado';
  state.qrDataUrl = null;
  state.me = null;

  setTimeout(() => {
    initialize();
  }, 3000);
}

module.exports = {
  client,
  state,
  initialize,
  listGroups,
  logout
};

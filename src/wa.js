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
    dumpio: true,
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

async function listGroups() {
  if (state.status !== 'conectado') {
    console.log('[Grupos] Ignorado: status =', state.status);
    return [];
  }

  let chats = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    chats = await client.getChats();
    const groupCount = chats.filter(c => c.isGroup).length;

    console.log(`[Grupos] Tentativa ${attempt}: ${chats.length} conversa(s), ${groupCount} grupo(s).`);

    if (groupCount > 0) break;
    if (attempt < 3) await new Promise(r => setTimeout(r, 4000));
  }

  return chats
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

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

// getChats() do WhatsApp Web às vezes trava (bug conhecido do Puppeteer):
// a chamada nunca resolve e, sem teto de tempo, o /api/groups fica pendurado
// para sempre — o painel espera sem mostrar grupo nem erro. Este teto força
// a falha para virar um erro visível (o painel recarrega sozinho a cada 3s).
const LISTAR_TIMEOUT_MS = 25000;

function getChatsComTimeout(ms) {
  return Promise.race([
    client.getChats(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`getChats travou (timeout ${ms / 1000}s)`)), ms))
  ]);
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
    let chats = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        chats = await getChatsComTimeout(LISTAR_TIMEOUT_MS);
      } catch (e) {
        console.log(`[Grupos] Tentativa ${attempt} falhou: ${e.message}`);
        throw new Error('O WhatsApp demorou demais para responder. Clique em "recarregar"; se continuar, reinicie o app.');
      }
      const groupCount = chats.filter(c => c.isGroup).length;

      console.log(`[Grupos] Tentativa ${attempt}: ${chats.length} conversa(s), ${groupCount} grupo(s).`);

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

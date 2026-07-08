const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');

const state = {
  status: 'iniciando',
  qrDataUrl: null,
  me: null,
  lastError: null
};

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--no-zygote',
      '--single-process',
      '--disable-features=dbus',
      '--disable-session-crashed-bubble',
      '--noerrdialogs'
    ]
  }
});

client.on('qr', async (qr) => {
  state.status = 'aguardando_qr';
  state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
  console.log('[WA] QR code gerado — escaneie na aba Conexão.');
});

client.on('authenticated', () => {
  state.status = 'autenticando';
  state.qrDataUrl = null;
  console.log('[WA] Autenticado, carregando sessão...');
});

client.on('ready', () => {
  state.status = 'conectado';
  state.qrDataUrl = null;
  state.me = {
    name: client.info.pushname,
    number: client.info.wid.user
  };
  console.log(`[WA] Conectado como ${state.me.name} (${state.me.number}).`);
  console.log('[WA] Sincronizando conversas... aguarde alguns segundos e clique em "recarregar".');
});

client.on('disconnected', (reason) => {
  state.status = 'desconectado';
  state.me = null;
  state.lastError = String(reason);
  console.log('[WA] Desconectado:', reason);
  setTimeout(() => client.initialize().catch(e => console.error('[WA] Falha ao reiniciar:', e.message)), 5000);
});

client.on('auth_failure', (msg) => {
  state.status = 'desconectado';
  state.lastError = 'Falha de autenticação: ' + msg;
  console.error('[WA] Falha de autenticação:', msg);
});

function initialize() {
  client.initialize().catch(e => {
    state.status = 'desconectado';
    state.lastError = e.message;
    console.error('[WA] Erro ao inicializar:', e.message);
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
        ? c.participants.some(p => p.id._serialized === client.info.wid._serialized && (p.isAdmin || p.isSuperAdmin))
        : false
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

async function logout() {
  try { await client.logout(); } catch {}
  state.status = 'desconectado';
  state.me = null;
  setTimeout(() => initialize(), 3000);
}

module.exports = { client, state, initialize, listGroups, logout };

// wa.js — conexão com o WhatsApp Web (sessão persistente via LocalAuth)
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');

const state = {
  status: 'iniciando',   // iniciando | aguardando_qr | autenticando | conectado | desconectado
  qrDataUrl: null,
  me: null,              // { name, number }
  lastError: null
};

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
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
  console.log('[WA] Sincronizando conversas... aguarde alguns segundos e clique em "recarregar" na lista de grupos se ela estiver vazia.');
});

client.on('disconnected', (reason) => {
  state.status = 'desconectado';
  state.me = null;
  state.lastError = String(reason);
  console.log('[WA] Desconectado:', reason);
  // tenta reinicializar após alguns segundos
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

  // WhatsApp pode não ter terminado de sincronizar as conversas logo após conectar.
  // Tentamos até 3 vezes, esperando entre elas, se não vier nenhum grupo.
  let chats = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    chats = await client.getChats();
    const groupCount = chats.filter(c => c.isGroup).length;
    console.log(`[Grupos] Tentativa ${attempt}: ${chats.length} conversa(s), ${groupCount} grupo(s).`);
    if (groupCount > 0) break;
    if (attempt < 3) await new Promise(r => setTimeout(r, 4000)); // aguarda sincronizar
  }

  const groups = chats
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

  if (groups.length === 0) {
    console.log('[Grupos] Nenhum grupo encontrado. Se voce TEM grupos, provavelmente e: (1) sincronizacao ainda em andamento — espere e recarregue, ou (2) whatsapp-web.js desatualizado — feche o app e rode "npm update whatsapp-web.js".');
  }
  return groups;
}

async function logout() {
  try { await client.logout(); } catch {}
  state.status = 'desconectado';
  state.me = null;
  setTimeout(() => initialize(), 3000);
}

module.exports = { client, state, initialize, listGroups, logout };

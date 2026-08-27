const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SESSION_DIR = path.join(__dirname, '..', '.wwebjs_auth');

// Mata Chrome órfão antes de subir outro. Quando o initialize() falha no meio
// (ex.: timeout de pareamento), o processo do Chrome CONTINUA vivo, mas o
// client perde a referência — então destroy() não o fecha. O próximo launch
// bate em "Failed to create a ProcessSingleton" e vira o erro
// "browser is already running", que trava a reconexão para sempre.
// Só roda em Linux (o container): evita matar o Chrome do desenvolvedor no Mac.
function matarChromeOrfaos() {
  if (process.platform !== 'linux') return;
  try {
    execFileSync('pkill', ['-f', 'google-chrome-stable'], { stdio: 'ignore' });
    console.log('[WA] Chrome(s) órfão(s) encerrado(s).');
  } catch (e) {
    // pkill sai com 1 quando não achou processo — situação normal.
  }
}

// O Chrome tranca a pasta do perfil com arquivos "Singleton*". Se um Chrome
// anterior não fechou direito, um novo launch falha com "browser is already
// running for .../session" — e a reconexão fica presa nesse erro para sempre.
// Isto remove esses locks antes de religar (o Dockerfile já faz no boot; aqui
// fazemos também em runtime, a cada reconexão).
function limparLocksDoChrome() {
  try {
    const stack = [SESSION_DIR];
    while (stack.length) {
      const dir = stack.pop();
      let itens = [];
      try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const it of itens) {
        const full = path.join(dir, it.name);
        if (it.name.startsWith('Singleton')) {
          try { fs.rmSync(full, { force: true }); console.log('[WA] lock removido:', full); } catch {}
        } else if (it.isDirectory()) {
          stack.push(full);
        }
      }
    }
  } catch (e) {
    console.log('[WA] limparLocksDoChrome falhou:', e.message);
  }
}

console.log('[WA] VERSAO DEFINITIVA: Google Chrome Stable, sem userDataDir, sem single-process, sem crashpad');

const state = {
  status: 'iniciando',
  qrDataUrl: null,
  me: null,
  lastError: null,
  // Aviso persistente mostrado no painel (não é limpo pelo initialize()).
  // Usado quando o logout falha e o aparelho continua vinculado no celular.
  aviso: null
};

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, '..', '.wwebjs_auth')
  }),
  // O padrão da lib é 30s para o socket sair de PAIRING/OPENING depois do QR.
  // Nesta VPS isso estourava ("Waiting failed: 30000ms exceeded"), a init
  // falhava no meio e deixava um Chrome órfão — que depois travava tudo com
  // "browser is already running". 2min dá folga para o pareamento concluir.
  authTimeoutMs: 120000,
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

// O WhatsApp manda as notificações para o aparelho que ele considera "ativo".
// Como este painel deixa a sessão web ligada 24h, o celular PARA de notificar
// as mensagens novas. Marcar a sessão como ausente (presence unavailable)
// devolve as notificações ao telefone sem derrubar a conexão — o envio segue
// funcionando normal. Desligue com ZG_MANTER_NOTIFICACOES=0 se preferir.
const MANTER_NOTIFICACOES = process.env.ZG_MANTER_NOTIFICACOES !== '0';
let presencaTimer = null;

async function marcarSessaoComoAusente() {
  if (!MANTER_NOTIFICACOES || state.status !== 'conectado') return;
  try { await client.sendPresenceUnavailable(); }
  catch (e) { /* best-effort: não pode atrapalhar o envio */ }
}

function manterNotificacoesNoCelular() {
  if (!MANTER_NOTIFICACOES) {
    console.log('[WA] Presença ativa (ZG_MANTER_NOTIFICACOES=0): o celular pode parar de notificar.');
    return;
  }
  clearInterval(presencaTimer);
  marcarSessaoComoAusente();
  // Reafirma periodicamente: enviar mensagem/"digitando" reativa a presença.
  presencaTimer = setInterval(marcarSessaoComoAusente, 60000);
  console.log('[WA] Sessão marcada como ausente — notificações seguem chegando no celular.');
}

client.on('ready', () => {
  state.status = 'conectado';
  state.qrDataUrl = null;
  state.lastError = null;
  state.aviso = null;
  retryDelayMs = RETRY_MIN_MS; // conectou: zera o backoff

  state.me = {
    name: client.info?.pushname || 'WhatsApp',
    number: client.info?.wid?.user || ''
  };

  manterNotificacoesNoCelular();

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

// Backoff progressivo: antes tentava de 30 em 30s para sempre. Se o WhatsApp
// estiver recusando a conexão, martelar sem parar só reforça o padrão de
// automação — agora o intervalo cresce (30s, 1min, 2min... até 15min).
const RETRY_MIN_MS = 30000;
const RETRY_MAX_MS = 15 * 60000;
let retryDelayMs = RETRY_MIN_MS;

// Trava para não ter dois initialize() rodando ao mesmo tempo — era isso que
// deixava DOIS Chrome disputando a mesma pasta de sessão ("browser is already
// running"). Só um fluxo de (re)conexão por vez.
let conectando = false;

function agendarReconexao() {
  clearTimeout(retryTimer);
  const espera = retryDelayMs;
  retryTimer = setTimeout(reiniciarConexao, espera);
  retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  console.log(`[WA] Nova tentativa de conexão em ${Math.round(espera / 1000)}s.`);
}

// Fecha o Chrome anterior e limpa os locks ANTES de subir um novo — evita a
// colisão de perfil que travava a reconexão.
async function reiniciarConexao() {
  if (conectando) { console.log('[WA] Reconexão já em andamento; ignorando.'); return; }
  conectando = true;
  clearTimeout(retryTimer);
  try {
    try { await client.destroy(); console.log('[WA] Chrome anterior encerrado.'); }
    catch (e) { console.log('[WA] destroy (ok ignorar):', e.message); }

    matarChromeOrfaos();
    limparLocksDoChrome();

    console.log('[WA] Inicializando WhatsApp...');
    state.status = 'iniciando';
    state.lastError = null;
    await client.initialize();
  } catch (e) {
    state.status = 'desconectado';
    state.qrDataUrl = null;
    state.me = null;
    state.lastError = e.message;
    console.error('[WA] Erro ao inicializar:', e.message);
    conectando = false;
    agendarReconexao();
    return;
  }
  conectando = false;
}

// Mantido para o boot e chamadas externas; delega para o fluxo guardado.
function initialize() {
  reiniciarConexao();
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
  // client.logout() é o que DESVINCULA o aparelho em "Aparelhos conectados"
  // no celular. Ele opera a página do WhatsApp Web, então pode falhar (página
  // quebrada, sessão morta). Antes o erro era engolido em silêncio e o app já
  // pedia QR novo: o vínculo antigo ficava pendurado e, depois de ~4 ciclos, o
  // WhatsApp passava a recusar novos aparelhos. Agora a falha é logada e vira
  // um aviso na tela, para o aparelho órfão ser removido na mão.
  try {
    await client.logout();
    state.aviso = null;
    console.log('[WA] Aparelho desvinculado com sucesso.');
  } catch (e) {
    state.aviso = 'Não consegui desvincular este aparelho automaticamente. Antes de escanear o QR, remova-o no celular em WhatsApp → Aparelhos conectados — senão a vaga fica ocupada e o WhatsApp acaba recusando novos aparelhos.';
    console.error('[WA] logout FALHOU:', (e && e.message) || e);
    console.error('[WA] ' + state.aviso);
  }

  state.status = 'desconectado';
  state.qrDataUrl = null;
  state.me = null;

  setTimeout(() => {
    initialize();
  }, 3000);
}

// Diagnóstico da prévia de link. A resposta do getLinkPreview vem com
// isLoading e thumbnail vazio — ou seja, ela retorna ANTES de terminar.
// Aqui chamamos várias vezes ao longo do tempo para ver se os campos da
// imagem (thumbnailDirectPath/Sha256/Width/Height, que as mensagens com
// prévia completa possuem) aparecem depois que o carregamento conclui.
async function inspecionarPrevia(url) {
  return await client.pupPage.evaluate(async (u) => {
    const dormir = ms => new Promise(r => setTimeout(r, ms));
    const resumo = (d) => {
      if (!d) return 'sem dados';
      const chaves = ['isLoading', 'title', 'thumbnail', 'thumbnailDirectPath', 'thumbnailSha256', 'thumbnailWidth', 'thumbnailHeight', 'richPreviewType'];
      const o = {};
      for (const k of chaves) {
        const v = d[k];
        o[k] = v === undefined ? '—'
          : (typeof v === 'string' ? (v.length > 40 ? `str(${v.length})` : (v || '(vazio)')) : v);
      }
      o.todosOsCampos = Object.keys(d).length;
      return o;
    };

    const { findLink } = window.require('WALinkify');
    const link = findLink(u);
    if (!link) return { erro: 'link não reconhecido' };
    const acao = window.require('WAWebLinkPreviewChatAction');

    const linha = [];
    for (const espera of [0, 2000, 3000, 5000, 5000, 10000]) {
      if (espera) await dormir(espera);
      let d = null, erro = null;
      try {
        const p = await acao.getLinkPreview(link);
        d = (p && p.data) || p || null;
      } catch (e) { erro = String(e && e.message || e); }
      linha.push({ apos: linha.length ? linha[linha.length - 1].apos + espera : 0, dados: erro || resumo(d) });
      // se a imagem já apareceu, não precisa esperar mais
      if (d && (d.thumbnailDirectPath || (d.thumbnail && d.thumbnail.length))) break;
    }

    // funções disponíveis no módulo (procurando algo que gere/suba a miniatura)
    let funcoes = [];
    try { funcoes = Object.keys(acao).filter(k => typeof acao[k] === 'function'); } catch (e) {}

    return { evolucao: linha, funcoesDoModulo: funcoes };
  }, url);
}

// Reset completo: apaga a sessão salva e força um QR novo. Útil quando a
// sessão está morta/travada (aparelho removido no celular, "browser already
// running", etc.) e o logout normal não resolve — não depende do WhatsApp Web
// estar respondendo, porque apaga os arquivos direto.
async function resetSession() {
  console.log('[WA] Reset de sessão solicitado.');
  conectando = true;              // segura reconexões concorrentes durante o reset
  clearTimeout(retryTimer);

  try { await client.destroy(); } catch (e) { console.log('[WA] destroy no reset (ok ignorar):', e.message); }

  // Apaga o CONTEÚDO de .wwebjs_auth (não a pasta em si, que é volume montado).
  try {
    for (const item of fs.readdirSync(SESSION_DIR)) {
      fs.rmSync(path.join(SESSION_DIR, item), { recursive: true, force: true });
    }
    console.log('[WA] Sessão apagada — vai pedir QR novo.');
  } catch (e) {
    console.log('[WA] Falha ao apagar sessão (segue mesmo assim):', e.message);
  }

  state.status = 'iniciando';
  state.me = null;
  state.qrDataUrl = null;
  state.lastError = null;
  state.aviso = null;
  retryDelayMs = RETRY_MIN_MS;
  conectando = false;

  reiniciarConexao();
}

module.exports = {
  client,
  state,
  initialize,
  listGroups,
  logout,
  resetSession,
  inspecionarPrevia
};

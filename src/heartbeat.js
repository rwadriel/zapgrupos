const https = require('https');

// O tópico ntfy funciona como uma senha: quem souber o nome recebe (e pode
// enviar) notificações. Por isso não existe valor padrão — sem a variável
// ZG_HEARTBEAT_NTFY_TOPIC o sinal fica desativado.
const TOPIC = process.env.ZG_HEARTBEAT_NTFY_TOPIC || '';

const MIN_HOURS = Number(process.env.ZG_HEARTBEAT_MIN_HOURS || 6);
const MAX_HOURS = Number(process.env.ZG_HEARTBEAT_MAX_HOURS || 14);
const CHECK_MINUTES = Number(process.env.ZG_HEARTBEAT_CHECK_MINUTES || 5);

let started = false;
let lastStatus = null;

function randomDelayMs() {
  const min = Math.max(1, MIN_HOURS) * 60 * 60 * 1000;
  const max = Math.max(MIN_HOURS, MAX_HOURS) * 60 * 60 * 1000;
  return Math.floor(min + Math.random() * (max - min));
}

function safeHeader(value, fallback = 'ZapGrupos') {
  const cleaned = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();

  return cleaned || fallback;
}

function sendNtfy(title, message, priority = 'default', tags = 'bell') {
  return new Promise((resolve, reject) => {
    if (!TOPIC) {
      return reject(new Error('Sinal desativado: defina a variável ZG_HEARTBEAT_NTFY_TOPIC com um tópico ntfy secreto.'));
    }
    const req = https.request({
      hostname: 'ntfy.sh',
      path: '/' + encodeURIComponent(TOPIC),
      method: 'POST',
      headers: {
        'Title': safeHeader(title),
        'Priority': safeHeader(priority, 'default'),
        'Tags': safeHeader(tags, 'bell'),
        'Content-Type': 'text/plain; charset=utf-8'
      }
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error('ntfy respondeu com status ' + res.statusCode));
      });
    });

    req.on('error', reject);
    req.write(message);
    req.end();
  });
}

function montarMensagem(wa) {
  const status = wa && wa.state ? wa.state.status : 'desconhecido';
  const me = wa && wa.state ? wa.state.me : null;
  const erro = wa && wa.state ? wa.state.lastError : null;

  let msg = 'Status do ZapGrupos: ' + status;

  if (me && me.number) {
    msg += '\nConta: ' + (me.name || 'WhatsApp') + ' - ' + me.number;
  }

  if (erro) {
    msg += '\nErro: ' + erro;
  }

  msg += '\nHorário: ' + new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo'
  });

  return msg;
}

async function enviarSinal(wa, manual = false) {
  const status = wa && wa.state ? wa.state.status : 'desconhecido';

  if (manual) {
    await sendNtfy(
      'Teste manual do ZapGrupos',
      montarMensagem(wa),
      'high',
      'bell'
    );
    return;
  }

  if (status === 'conectado') {
    await sendNtfy(
      'ZapGrupos ativo',
      montarMensagem(wa),
      'default',
      'white_check_mark'
    );
  } else {
    await sendNtfy(
      'ZapGrupos precisa de atencao',
      montarMensagem(wa),
      'high',
      'warning'
    );
  }
}

async function enviarSinalManual(wa) {
  await enviarSinal(wa, true);
}

// Notificação avulsa (usada pelo agendador para avisar expiração de jobs).
// Sem tópico configurado, vira um no-op silencioso.
async function notificar(title, message, priority = 'high', tags = 'warning') {
  if (!TOPIC) return;
  await sendNtfy(title, message, priority, tags);
}

function agendarSinalAleatorio(wa) {
  const delay = randomDelayMs();
  const horas = Math.round((delay / 3600000) * 10) / 10;

  console.log('[SINAL] Proximo sinal aleatorio em aproximadamente ' + horas + ' hora(s).');

  setTimeout(async () => {
    try {
      await enviarSinal(wa, false);
    } catch (err) {
      console.log('[SINAL] Falha ao enviar sinal aleatorio:', err.message);
    }

    agendarSinalAleatorio(wa);
  }, delay);
}

function vigiarMudancaDeStatus(wa) {
  setInterval(async () => {
    const statusAtual = wa && wa.state ? wa.state.status : 'desconhecido';

    if (lastStatus && statusAtual !== lastStatus) {
      try {
        if (statusAtual === 'conectado') {
          await sendNtfy(
            'WhatsApp reconectado',
            'Status anterior: ' + lastStatus + '\n' + montarMensagem(wa),
            'default',
            'white_check_mark'
          );
        } else {
          await sendNtfy(
            'WhatsApp mudou de status',
            'Status anterior: ' + lastStatus + '\n' + montarMensagem(wa),
            'high',
            'warning'
          );
        }
      } catch (err) {
        console.log('[SINAL] Falha ao avisar mudanca de status:', err.message);
      }
    }

    lastStatus = statusAtual;
  }, Math.max(1, CHECK_MINUTES) * 60 * 1000);
}

function start(wa) {
  if (started) return;
  started = true;

  if (!TOPIC) {
    console.log('[SINAL] Desativado — defina ZG_HEARTBEAT_NTFY_TOPIC com um tópico secreto do ntfy.sh para ativar os avisos no celular.');
    return;
  }

  console.log('[SINAL] Ativado.');
  console.log('[SINAL] Topico ntfy:', TOPIC);

  setTimeout(() => {
    lastStatus = wa && wa.state ? wa.state.status : 'desconhecido';

    enviarSinal(wa, false).catch(err => {
      console.log('[SINAL] Falha ao enviar sinal inicial:', err.message);
    });
  }, 90000);

  vigiarMudancaDeStatus(wa);
  agendarSinalAleatorio(wa);
}

module.exports = {
  start,
  enviarSinalManual,
  notificar
};

// scheduler.js — verifica a fila a cada 15s e dispara os jobs vencidos
const store = require('./store');
const { runJob } = require('./sender');
const { state } = require('./wa');

let running = false;

// Job atrasado além deste limite não dispara mais: vira "expirada" (ou pula
// para a próxima ocorrência, se for recorrente). Evita rajada de mensagens
// velhas quando o servidor/WhatsApp fica um bom tempo fora do ar.
const MAX_ATRASO_MS = Math.max(1, Number(process.env.ZG_MAX_ATRASO_MINUTOS) || 60) * 60000;

function nextOccurrence(sendAtISO, repeat) {
  const d = new Date(sendAtISO);
  const now = new Date();
  const stepMs = repeat === 'semanal' ? 7 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
  do {
    d.setTime(d.getTime() + stepMs);
  } while (d <= now);
  return d.toISOString();
}

async function processJob(job) {
  store.updateJob(job.id, { status: 'enviando', results: [] });
  const results = await runJob(job, (partial) => {
    store.updateJob(job.id, { results: partial });
  });

  const okCount = results.filter(r => r.ok).length;
  const status =
    okCount === results.length ? 'enviada' :
    okCount > 0 ? 'parcial' : 'falhou';

  store.updateJob(job.id, { status, results, sentAt: new Date().toISOString() });

  // Recorrência: cria a próxima ocorrência como novo job agendado
  if (job.repeat && job.repeat !== 'nenhuma' && status !== 'cancelada') {
    const clone = {
      ...job,
      id: require('crypto').randomUUID(),
      status: 'agendada',
      sendAt: nextOccurrence(job.sendAt, job.repeat),
      results: [],
      sentAt: null,
      createdAt: new Date().toISOString()
    };
    store.addJob(clone);
    console.log(`[Agendador] Recorrência ${job.repeat}: próxima em ${clone.sendAt}`);
  }
}

async function tick() {
  if (running) return;
  if (state.status !== 'conectado') return; // aguarda conexão; envia assim que reconectar
  const now = new Date();
  const due = store.listJobs().filter(j => j.status === 'agendada' && new Date(j.sendAt) <= now);
  if (!due.length) return;

  running = true;
  try {
    for (const job of due) {
      const atraso = now - new Date(job.sendAt);
      if (atraso > MAX_ATRASO_MS) {
        if (job.repeat && job.repeat !== 'nenhuma') {
          const next = nextOccurrence(job.sendAt, job.repeat);
          store.updateJob(job.id, { sendAt: next });
          console.log(`[Agendador] Job ${job.id} atrasado ${Math.round(atraso / 60000)}min; recorrente, pulou para ${next}.`);
        } else {
          store.updateJob(job.id, { status: 'expirada' });
          console.log(`[Agendador] Job ${job.id} atrasado ${Math.round(atraso / 60000)}min; marcado como expirado (limite ${MAX_ATRASO_MS / 60000}min).`);
        }
        continue;
      }
      console.log(`[Agendador] Disparando job ${job.id} (${job.type}) para ${job.groupIds.length} grupo(s).`);
      await processJob(job);
    }
  } catch (e) {
    console.error('[Agendador] Erro:', e.message);
  } finally {
    running = false;
  }
}

function start() {
  // Job que ficou preso em "enviando" (restart no meio do envio) vira "falhou"
  // para poder ser reenviado pela fila, em vez de ficar travado para sempre.
  for (const job of store.listJobs()) {
    if (job.status === 'enviando') {
      store.updateJob(job.id, { status: 'falhou' });
      console.log(`[Agendador] Job ${job.id} estava "enviando" durante o restart; marcado como falhou.`);
    }
  }

  setInterval(tick, 15000);
  console.log(`[Agendador] Ativo — verificando a fila a cada 15s (atraso máximo tolerado: ${MAX_ATRASO_MS / 60000}min).`);
}

module.exports = { start, processJob };

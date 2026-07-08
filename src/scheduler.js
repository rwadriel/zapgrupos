// scheduler.js — verifica a fila a cada 15s e dispara os jobs vencidos
const store = require('./store');
const { runJob } = require('./sender');
const { state } = require('./wa');

let running = false;

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
  setInterval(tick, 15000);
  console.log('[Agendador] Ativo — verificando a fila a cada 15s.');
}

module.exports = { start, processJob };

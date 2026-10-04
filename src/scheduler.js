// scheduler.js — verifica a fila a cada 15s e dispara os jobs vencidos
const store = require('./store');
const { runJob, gruposPendentes } = require('./sender');
const { state } = require('./wa');
const heartbeat = require('./heartbeat');

let running = false;

// Job atrasado além deste limite não dispara mais: vira "expirada" (ou pula
// para a próxima ocorrência, se for recorrente). Evita rajada de mensagens
// velhas quando o servidor/WhatsApp fica um bom tempo fora do ar.
//
// Era 5min, o que descartava etapas de campanha por qualquer instabilidade
// curta (reinício de container, reconexão do WhatsApp) — foi o que fez
// campanhas de vários dias enviarem só o primeiro dia. 60min tolera essas
// quedas e ainda evita disparar mensagem de horas atrás.
const MAX_ATRASO_MS = Math.max(1, Number(process.env.ZG_MAX_ATRASO_MINUTOS) || 60) * 60000;

// Reenvio automático: uma queda do app no meio do envio (ou um erro
// passageiro do WhatsApp) deixava a mensagem como "falhou" para sempre,
// esperando alguém clicar em Reenviar. Agora o próprio agendador tenta de
// novo, com espera crescente, e SÓ para os grupos que ainda não receberam —
// quem já recebeu não recebe duplicado. ZG_RETENTATIVAS=0 desliga.
const MAX_TENTATIVAS = Math.max(0, Number(process.env.ZG_RETENTATIVAS ?? 5));
const ESPERAS_MIN = [2, 5, 15, 30, 60];
const esperaDaTentativa = (n) => ESPERAS_MIN[Math.min(n, ESPERAS_MIN.length - 1)] * 60000;

// Erro que não adianta repetir (o arquivo não existe mais no servidor).
function ehErroPermanente(results) {
  return (results || []).some(r => !r.ok && /não encontrado no servidor/i.test(String(r.error || '')));
}

function descreverJob(job) {
  const quando = new Date(job.sendAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const grupos = (job.groupNames || []).join(', ') || `${(job.groupIds || []).length} grupo(s)`;
  return `Tipo: ${job.type}\nAgendada para: ${quando}\nGrupos: ${grupos}`;
}

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
  // Trava contra duplo envio: o tick do agendador e o botão "Enviar agora"
  // podem chamar processJob para o mesmo job quase ao mesmo tempo (ou o
  // usuário clica duas vezes). A checagem+marcação é síncrona, então a
  // segunda chamada sempre vê "enviando" e desiste.
  const atual = store.getJob(job.id);
  if (!atual || atual.status === 'enviando') return;
  store.updateJob(job.id, { status: 'enviando', results: [] });

  const results = await runJob(job, (partial) => {
    store.updateJob(job.id, { results: partial });
  });

  const okCount = results.filter(r => r.ok).length;
  const status =
    okCount === results.length ? 'enviada' :
    okCount > 0 ? 'parcial' : 'falhou';

  // Agenda a próxima tentativa, se ainda fizer sentido tentar.
  const patch = { status, results, sentAt: new Date().toISOString() };
  let vaiRetentar = false;
  if (status !== 'enviada') {
    const tentativas = (job.tentativas || 0) + 1;
    const faltam = gruposPendentes({ groupIds: job.groupIds, results }).length;
    vaiRetentar = MAX_TENTATIVAS > 0 && tentativas <= MAX_TENTATIVAS && faltam > 0 && !ehErroPermanente(results);
    patch.tentativas = tentativas;
    patch.proximaTentativaEm = vaiRetentar
      ? new Date(Date.now() + esperaDaTentativa(tentativas - 1)).toISOString()
      : null;
    if (vaiRetentar) {
      console.log(`[Agendador] Job ${job.id}: ${faltam} grupo(s) sem entrega. Tentativa ${tentativas}/${MAX_TENTATIVAS} em ${Math.round(esperaDaTentativa(tentativas - 1) / 60000)}min.`);
    }
  }
  store.updateJob(job.id, patch);

  // Só avisa no celular quando desistiu de vez — senão vira spam a cada tentativa.
  if ((status === 'falhou' || status === 'parcial') && !vaiRetentar) {
    const falhas = results.filter(r => !r.ok);
    // Log do motivo real da falha — sem isto o container só mostrava
    // "Disparando job..." e o erro ficava escondido dentro do db.json.
    for (const f of falhas) {
      console.log(`[Agendador] FALHA job ${job.id} grupo ${f.groupId}: ${f.error}`);
    }
    heartbeat.notificar(
      status === 'falhou' ? 'ZapGrupos: envio FALHOU' : 'ZapGrupos: envio parcial',
      `${falhas.length} de ${results.length} grupo(s) falharam.\n${descreverJob(job)}\nErro: ${falhas[0]?.error || 'desconhecido'}\nReenvie pela aba Fila.`,
      'high', status === 'falhou' ? 'rotating_light' : 'warning'
    ).catch(err => console.log('[Agendador] Falha ao notificar ntfy:', err.message));
  }

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
  // Reenvios vencidos entram na mesma rodada (não passam pela regra de atraso:
  // são retentativas, não mensagens agendadas que ficaram para trás).
  const retentar = store.listJobs().filter(j =>
    (j.status === 'falhou' || j.status === 'parcial') &&
    j.proximaTentativaEm && new Date(j.proximaTentativaEm) <= now);
  if (!due.length && !retentar.length) return;

  running = true;
  try {
    for (const job of due) {
      const atraso = now - new Date(job.sendAt);
      if (atraso > MAX_ATRASO_MS) {
        const atrasoMin = Math.round(atraso / 60000);
        if (job.repeat && job.repeat !== 'nenhuma') {
          const next = nextOccurrence(job.sendAt, job.repeat);
          store.updateJob(job.id, { sendAt: next });
          console.log(`[Agendador] Job ${job.id} atrasado ${atrasoMin}min; recorrente, pulou para ${next}.`);
          heartbeat.notificar(
            'ZapGrupos: recorrente pulada',
            `Uma mensagem recorrente atrasou ${atrasoMin}min e foi pulada para a próxima ocorrência.\n${descreverJob(job)}`,
            'default', 'fast_forward'
          ).catch(err => console.log('[Agendador] Falha ao notificar ntfy:', err.message));
        } else {
          store.updateJob(job.id, { status: 'expirada' });
          console.log(`[Agendador] Job ${job.id} atrasado ${atrasoMin}min; marcado como expirado (limite ${MAX_ATRASO_MS / 60000}min).`);
          heartbeat.notificar(
            'ZapGrupos: mensagem NAO enviada (expirou)',
            `Uma mensagem atrasou ${atrasoMin}min (limite ${MAX_ATRASO_MS / 60000}min) e NÃO foi enviada.\n${descreverJob(job)}\nPara mandar mesmo assim, use "Reenviar" na aba Fila.`,
            'high', 'warning'
          ).catch(err => console.log('[Agendador] Falha ao notificar ntfy:', err.message));
        }
        continue;
      }
      console.log(`[Agendador] Disparando job ${job.id} (${job.type}) para ${job.groupIds.length} grupo(s).`);
      // try/catch POR JOB: antes o try envolvia o laço inteiro, então uma
      // exceção em um job abandonava todos os seguintes daquele ciclo — numa
      // campanha de vários dias, um erro no dia 1 podia travar os dias 2 e 3.
      try {
        await processJob(job);
      } catch (e) {
        console.error(`[Agendador] Job ${job.id} estourou (os demais continuam):`, e.message);
        try { store.updateJob(job.id, { status: 'falhou', results: [{ ok: false, error: e.message, at: new Date().toISOString() }] }); } catch {}
      }
    }
    for (const job of retentar) {
      const faltam = gruposPendentes(job).length;
      console.log(`[Agendador] Reenviando job ${job.id} (tentativa ${(job.tentativas || 0) + 1}) para ${faltam} grupo(s) pendente(s).`);
      try {
        store.updateJob(job.id, { proximaTentativaEm: null, status: 'agendada' });
        await processJob({ ...job, status: 'agendada' });
      } catch (e) {
        console.error(`[Agendador] Reenvio do job ${job.id} estourou:`, e.message);
      }
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
      // Reinício no meio do envio: agenda uma retentativa em 2min em vez de
      // deixar a mensagem parada esperando alguém clicar em Reenviar.
      store.updateJob(job.id, {
        status: 'falhou',
        proximaTentativaEm: new Date(Date.now() + 2 * 60000).toISOString()
      });
      console.log(`[Agendador] Job ${job.id} estava "enviando" durante o restart; retentativa em 2min.`);
    }
  }

  setInterval(tick, 15000);
  console.log(`[Agendador] Ativo — verificando a fila a cada 15s (atraso máximo tolerado: ${MAX_ATRASO_MS / 60000}min).`);
}

module.exports = { start, processJob, tick };

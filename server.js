// server.js — ZapGrupos: agendador + campanhas para grupos WhatsApp
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const wa = require('./src/wa');
const store = require('./src/store');
const sessions = require('./src/sessions');
const scheduler = require('./src/scheduler'); const heartbeat = require('./src/heartbeat');

const PORT = process.env.PORT || 3900;
const MEDIA_DIR = path.join(__dirname, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ===== AUTH =====
const SENHA = process.env.ZAPGRUPOS_SENHA || '';

function gerarToken() { return crypto.randomBytes(32).toString('hex'); }

function senhaConfere(tentativa) {
  const a = Buffer.from(String(tentativa || ''));
  const b = Buffer.from(SENHA);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Rate limit do login: o painel fica exposto na internet, então sem isto
// um robô pode testar senhas à vontade. Máx. 5 erros por IP por minuto.
const falhasLogin = new Map(); // ip -> [timestamps]

function loginBloqueado(ip) {
  const agora = Date.now();
  const recentes = (falhasLogin.get(ip) || []).filter(t => agora - t < 60000);
  if (recentes.length) falhasLogin.set(ip, recentes); else falhasLogin.delete(ip);
  return recentes.length >= 5;
}

function registrarFalhaLogin(ip) {
  const arr = falhasLogin.get(ip) || [];
  arr.push(Date.now());
  falhasLogin.set(ip, arr);
}

function parseCookies(req, res, next) {
  req.cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.split('=');
    if (k) req.cookies[k.trim()] = v.join('=').trim();
  });
  next();
}


// ===== DATAS COM FUSO DO BRASIL =====
function zgGetClientOffsetMinutes(value) {
  const n = Number.parseInt(value, 10);
  if (Number.isFinite(n) && Math.abs(n) <= 14 * 60) return n;
  return 180; // America/Sao_Paulo
}

function zgParseClientDateTime(value, offsetMinutes = 180) {
  if (!value) return null;
  const raw = String(value).trim();

  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const [, yy, mo, dd, hh, mi, ss = '0'] = m;
  const utcMs = Date.UTC(+yy, +mo - 1, +dd, +hh, +mi, +ss) + offsetMinutes * 60000;
  const d = new Date(utcMs);
  return Number.isNaN(d.getTime()) ? null : d;
}

function zgBuildClientDateFromParts(dateValue, timeValue, dayOffset = 0, offsetMinutes = 180) {
  const dm = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = String(timeValue || '09:00').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!dm || !tm) return null;

  const [, yy, mo, dd] = dm;
  const [, hh, mi, ss = '0'] = tm;
  const utcMs = Date.UTC(+yy, +mo - 1, +dd + (Number.parseInt(dayOffset, 10) || 0), +hh, +mi, +ss) + offsetMinutes * 60000;
  const d = new Date(utcMs);
  return Number.isNaN(d.getTime()) ? null : d;
}

function zgIsPastOrTooClose(date, graceMs = 5000) {
  return !date || Number.isNaN(date.getTime()) || date.getTime() <= Date.now() + graceMs;
}

function authMiddleware(req, res, next) {
  if (!SENHA) return next();
  if (req.path === '/api/login') return next();
  const token = (req.cookies && req.cookies.zg_token)
    || (req.headers.authorization || '').replace('Bearer ', '')
    || req.query.token;
  if (sessions.has(token)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Faça login.' });
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
}

// ===== UPLOAD =====
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 64 * 1024 * 1024 }
});

const app = express();
app.set('trust proxy', 1); // atrás do proxy do EasyPanel: req.ip = IP real do visitante
app.use(express.json({ limit: '10mb' }));
app.use(parseCookies);

// Auth
app.post('/api/login', (req, res) => {
  if (!SENHA) return res.json({ ok: true, token: 'none' });
  if (loginBloqueado(req.ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um minuto.' });
  if (!senhaConfere(req.body.senha)) {
    registrarFalhaLogin(req.ip);
    return res.status(403).json({ error: 'Senha incorreta.' });
  }
  const token = gerarToken();
  sessions.add(token);
  res.cookie('zg_token', token, { httpOnly: true, maxAge: sessions.TTL_MS, sameSite: 'lax' });
  res.json({ ok: true, token });
});
app.post('/api/logout-session', (req, res) => {
  sessions.remove((req.cookies && req.cookies.zg_token) || '');
  res.clearCookie('zg_token');
  res.json({ ok: true });
});

app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// ===== Upload genérico (usado por campanhas) =====
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Envie um arquivo.' });
  res.json({ filePath: req.file.path, fileName: req.file.originalname });
});

// ===== Status / Conexão =====
app.get('/api/status', (req, res) => {
  res.json({ status: wa.state.status, qr: wa.state.qrDataUrl, me: wa.state.me, lastError: wa.state.lastError });
});
app.post('/api/logout', async (req, res) => { await wa.logout(); res.json({ ok: true }); });

// ===== Grupos =====
app.get('/api/groups', async (req, res) => {
  try { res.json(await wa.listGroups()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Jobs (mensagens avulsas) =====
app.get('/api/jobs', (req, res) => res.json(store.listJobs()));

app.post('/api/jobs', upload.single('file'), (req, res) => {
  try {
    const b = req.body;
    const groupIds = JSON.parse(b.groupIds || '[]');
    if (!groupIds.length) return res.status(400).json({ error: 'Selecione ao menos um grupo.' });

    const type = b.type;
    if (!['texto', 'midia', 'audio', 'enquete'].includes(type)) return res.status(400).json({ error: 'Tipo de mensagem inválido.' });
    if (type === 'texto' && !b.text) return res.status(400).json({ error: 'Escreva o texto.' });
    if ((type === 'midia' || type === 'audio') && !req.file) return res.status(400).json({ error: 'Envie o arquivo de mídia.' });

    let pollOptions = [];
    if (type === 'enquete') {
      pollOptions = JSON.parse(b.pollOptions || '[]').map(s => s.trim()).filter(Boolean);
      if (!b.pollQuestion || pollOptions.length < 2) return res.status(400).json({ error: 'Enquete precisa de pergunta e ao menos 2 opções.' });
    }

    const sendNow = b.sendNow === 'true';
    const offset = zgGetClientOffsetMinutes(b.clientOffsetMinutes || b.timezoneOffset || b.tzOffset);
    const sendAtDate = sendNow ? new Date() : zgParseClientDateTime(b.sendAtISO || b.sendAt, offset);

    if (!sendNow && !sendAtDate) return res.status(400).json({ error: 'Data/hora inválida.' });
    if (!sendNow && zgIsPastOrTooClose(sendAtDate)) {
      return res.status(400).json({ error: 'Escolha uma data/hora futura. O agendamento não foi enviado imediatamente.' });
    }

    const job = {
      id: crypto.randomUUID(), status: 'agendada', type, groupIds,
      groupNames: JSON.parse(b.groupNames || '[]'),
      text: b.text || null, caption: b.caption || null,
      filePath: req.file ? req.file.path : null, fileName: req.file ? req.file.originalname : null,
      pollQuestion: b.pollQuestion || null, pollOptions, allowMultiple: b.allowMultiple === 'true',
      mentionAll: b.mentionAll === 'true', humanize: b.humanize !== 'false',
      repeat: b.repeat || 'nenhuma', sendAt: sendAtDate.toISOString(),
      results: [], createdAt: new Date().toISOString()
    };

    store.addJob(job);

    if (sendNow) {
      scheduler.processJob(job).catch(e => {
        store.updateJob(job.id, { status: 'falhou', results: [{ ok: false, error: e.message }] });
      });
    }

    res.json(job);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/jobs/:id/send-now', (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Não encontrado.' });
  if (!['agendada', 'falhou', 'parcial', 'expirada'].includes(job.status))
    return res.status(400).json({ error: 'Não pode ser reenviado agora.' });
  scheduler.processJob(job).catch(e => {
    store.updateJob(job.id, { status: 'falhou', results: [{ ok: false, error: e.message }] });
  });
  res.json({ ok: true });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = store.updateJob(req.params.id, { status: 'cancelada' });
  if (!job) return res.status(404).json({ error: 'Não encontrado.' });
  res.json(job);
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = store.getJob(req.params.id);
  // Só apaga o arquivo se nenhum outro job ou etapa de campanha usar o mesmo
  // (lançamentos de campanha compartilham a mídia da etapa original).
  if (job && job.filePath && store.countFileRefs(job.filePath, job.id) === 0) {
    try { fs.unlinkSync(job.filePath); } catch {}
  }
  res.json({ ok: store.removeJob(req.params.id) });
});

// ===== Campanhas =====
app.get('/api/campaigns', (req, res) => res.json(store.listCampaigns()));

app.post('/api/campaigns', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Dê um nome à campanha.' });
  const campaign = {
    id: crypto.randomUUID(), name, description: description || '',
    steps: [], createdAt: new Date().toISOString()
  };
  res.json(store.addCampaign(campaign));
});

app.put('/api/campaigns/:id', (req, res) => {
  const c = store.updateCampaign(req.params.id, req.body);
  if (!c) return res.status(404).json({ error: 'Campanha não encontrada.' });
  res.json(c);
});

app.delete('/api/campaigns/:id', (req, res) => {
  res.json({ ok: store.removeCampaign(req.params.id) });
});

// Adicionar etapa
app.post('/api/campaigns/:id/steps', upload.single('file'), (req, res) => {
  const c = store.getCampaign(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campanha não encontrada.' });
  const b = req.body;
  const step = {
    id: crypto.randomUUID(),
    order: c.steps.length + 1,
    dayOffset: parseInt(b.dayOffset) || 0,
    time: b.time || '09:00',
    type: b.type || 'texto',
    text: b.text || null,
    caption: b.caption || null,
    filePath: req.file ? req.file.path : null,
    fileName: req.file ? req.file.originalname : null,
    pollQuestion: b.pollQuestion || null,
    pollOptions: b.pollOptions ? JSON.parse(b.pollOptions) : [],
    allowMultiple: b.allowMultiple === 'true',
    mentionAll: b.mentionAll === 'true',
    humanize: b.humanize !== 'false'
  };
  c.steps.push(step);
  store.updateCampaign(c.id, { steps: c.steps });
  res.json(step);
});

// Atualizar etapa
app.put('/api/campaigns/:id/steps/:stepId', upload.single('file'), (req, res) => {
  const c = store.getCampaign(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campanha não encontrada.' });
  const step = c.steps.find(s => s.id === req.params.stepId);
  if (!step) return res.status(404).json({ error: 'Etapa não encontrada.' });
  const b = req.body;
  if (b.dayOffset !== undefined) step.dayOffset = parseInt(b.dayOffset);
  if (b.time) step.time = b.time;
  if (b.type) step.type = b.type;
  if (b.text !== undefined) step.text = b.text;
  if (b.caption !== undefined) step.caption = b.caption;
  if (req.file) { step.filePath = req.file.path; step.fileName = req.file.originalname; }
  if (b.pollQuestion !== undefined) step.pollQuestion = b.pollQuestion;
  if (b.pollOptions) step.pollOptions = JSON.parse(b.pollOptions);
  if (b.allowMultiple !== undefined) step.allowMultiple = b.allowMultiple === 'true';
  if (b.mentionAll !== undefined) step.mentionAll = b.mentionAll === 'true';
  if (b.humanize !== undefined) step.humanize = b.humanize !== 'false';
  store.updateCampaign(c.id, { steps: c.steps });
  res.json(step);
});

// Remover etapa
app.delete('/api/campaigns/:id/steps/:stepId', (req, res) => {
  const c = store.getCampaign(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campanha não encontrada.' });
  c.steps = c.steps.filter(s => s.id !== req.params.stepId);
  c.steps.forEach((s, i) => s.order = i + 1);
  store.updateCampaign(c.id, { steps: c.steps });
  res.json({ ok: true });
});

// ===== Lançar campanha =====
app.post('/api/campaigns/:id/launch', (req, res) => {
  try {
    const c = store.getCampaign(req.params.id);
    if (!c) return res.status(404).json({ error: 'Campanha não encontrada.' });

    const { startDate, groupIds, groupNames, steps, clientOffsetMinutes, timezoneOffset, tzOffset } = req.body;
    const offset = zgGetClientOffsetMinutes(clientOffsetMinutes ?? timezoneOffset ?? tzOffset);

    if (!startDate) return res.status(400).json({ error: 'Escolha a data de início.' });
    if (!groupIds || !groupIds.length) return res.status(400).json({ error: 'Selecione ao menos um grupo.' });
    if (!steps || !steps.length) return res.status(400).json({ error: 'A campanha não tem etapas.' });

    const jobIds = [];
    const normalizedSteps = steps
      .slice()
      .sort((a, b) => (a.dayOffset || 0) === (b.dayOffset || 0)
        ? String(a.time || '09:00').localeCompare(String(b.time || '09:00'))
        : (a.dayOffset || 0) - (b.dayOffset || 0));

    for (const step of normalizedSteps) {
      // O filePath vem do navegador: só aceita arquivos dentro de media/.
      if (step.filePath && !path.resolve(String(step.filePath)).startsWith(MEDIA_DIR + path.sep)) {
        return res.status(400).json({ error: `O arquivo da etapa ${step.order || ''} é inválido. Envie a mídia novamente.` });
      }

      const sendDate = zgBuildClientDateFromParts(startDate, step.time || '09:00', step.dayOffset || 0, offset);

      if (!sendDate) {
        return res.status(400).json({ error: `Data/hora inválida na etapa ${step.order || ''}.` });
      }

      if (zgIsPastOrTooClose(sendDate)) {
        return res.status(400).json({
          error: `A etapa ${step.order || ''} ficou no passado. Ajuste a data de início ou o horário para entrar na fila.`
        });
      }

      const job = {
        id: crypto.randomUUID(), status: 'agendada', type: step.type,
        groupIds, groupNames,
        text: step.text || null, caption: step.caption || null,
        filePath: step.filePath || null, fileName: step.fileName || null,
        pollQuestion: step.pollQuestion || null,
        pollOptions: step.pollOptions || [],
        allowMultiple: !!step.allowMultiple,
        mentionAll: !!step.mentionAll, humanize: step.humanize !== false,
        repeat: 'nenhuma', sendAt: sendDate.toISOString(),
        results: [],
        campaignId: c.id, campaignName: c.name, stepOrder: step.order,
        createdAt: new Date().toISOString()
      };

      store.addJob(job);
      jobIds.push(job.id);
    }

    const launch = {
      id: crypto.randomUUID(),
      campaignId: c.id, campaignName: c.name,
      startDate, groupIds, groupNames,
      stepCount: normalizedSteps.length, jobIds,
      launchedAt: new Date().toISOString()
    };

    store.addLaunch(launch);
    res.json({ ok: true, launch, jobCount: jobIds.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Histórico de lançamentos =====
app.get('/api/launches', (req, res) => res.json(store.listLaunches()));


// ===== Teste manual de sinal no iPhone =====
app.post('/api/sinal/test', async (req, res) => {
  try {
    await heartbeat.enviarSinalManual(wa);
    res.json({
      ok: true,
      status: wa.state.status,
      message: 'Sinal enviado para o iPhone.'
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

// ===== Boot =====
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │  ZapGrupos — agendador de grupos WhatsApp   │');
  console.log(`  │  Painel: http://localhost:${PORT}              │`);
  if (SENHA) console.log('  │  🔒 Protegido por senha                     │');
  else       console.log('  │  ⚠️  Sem senha (modo local)                  │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
  wa.initialize(); scheduler.start(); heartbeat.start(wa);
});

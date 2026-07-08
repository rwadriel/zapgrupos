// server.js — ZapGrupos: agendador + campanhas para grupos WhatsApp
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const wa = require('./src/wa');
const store = require('./src/store');
const scheduler = require('./src/scheduler');

const PORT = process.env.PORT || 3900;
const MEDIA_DIR = path.join(__dirname, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ===== AUTH =====
const SENHA = process.env.ZAPGRUPOS_SENHA || '';
const SESSIONS = new Set();

function gerarToken() { return crypto.randomBytes(32).toString('hex'); }

function parseCookies(req, res, next) {
  req.cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.split('=');
    if (k) req.cookies[k.trim()] = v.join('=').trim();
  });
  next();
}

function authMiddleware(req, res, next) {
  if (!SENHA) return next();
  if (req.path === '/api/login') return next();
  const token = (req.cookies && req.cookies.zg_token)
    || (req.headers.authorization || '').replace('Bearer ', '')
    || req.query.token;
  if (token && SESSIONS.has(token)) return next();
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
app.use(express.json({ limit: '10mb' }));
app.use(parseCookies);

// Auth
app.post('/api/login', (req, res) => {
  if (!SENHA) return res.json({ ok: true, token: 'none' });
  if (req.body.senha !== SENHA) return res.status(403).json({ error: 'Senha incorreta.' });
  const token = gerarToken();
  SESSIONS.add(token);
  if (SESSIONS.size > 50) { const [oldest] = SESSIONS; SESSIONS.delete(oldest); }
  res.cookie('zg_token', token, { httpOnly: true, maxAge: 7 * 24 * 3600 * 1000, sameSite: 'lax' });
  res.json({ ok: true, token });
});
app.post('/api/logout-session', (req, res) => {
  SESSIONS.delete((req.cookies && req.cookies.zg_token) || '');
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
    if (!['texto', 'midia', 'audio', 'enquete'].includes(type))
      return res.status(400).json({ error: 'Tipo de mensagem inválido.' });
    if (type === 'texto' && !b.text) return res.status(400).json({ error: 'Escreva o texto.' });
    if ((type === 'midia' || type === 'audio') && !req.file)
      return res.status(400).json({ error: 'Envie o arquivo de mídia.' });

    let pollOptions = [];
    if (type === 'enquete') {
      pollOptions = JSON.parse(b.pollOptions || '[]').map(s => s.trim()).filter(Boolean);
      if (!b.pollQuestion || pollOptions.length < 2)
        return res.status(400).json({ error: 'Enquete precisa de pergunta e ao menos 2 opções.' });
    }

    const sendNow = b.sendNow === 'true';
    const sendAt = sendNow ? new Date().toISOString() : new Date(b.sendAt).toISOString();
    if (!sendNow && (!b.sendAt || isNaN(new Date(b.sendAt)))) return res.status(400).json({ error: 'Data/hora inválida.' });

    const job = {
      id: crypto.randomUUID(), status: 'agendada', type, groupIds,
      groupNames: JSON.parse(b.groupNames || '[]'),
      text: b.text || null, caption: b.caption || null,
      filePath: req.file ? req.file.path : null, fileName: req.file ? req.file.originalname : null,
      pollQuestion: b.pollQuestion || null, pollOptions, allowMultiple: b.allowMultiple === 'true',
      mentionAll: b.mentionAll === 'true', humanize: b.humanize !== 'false',
      repeat: b.repeat || 'nenhuma', sendAt, results: [], createdAt: new Date().toISOString()
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
  if (!['agendada', 'falhou', 'parcial'].includes(job.status))
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
  if (job && job.filePath) { try { fs.unlinkSync(job.filePath); } catch {} }
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
    const { startDate, groupIds, groupNames, steps } = req.body;
    if (!startDate) return res.status(400).json({ error: 'Escolha a data de início.' });
    if (!groupIds || !groupIds.length) return res.status(400).json({ error: 'Selecione ao menos um grupo.' });
    if (!steps || !steps.length) return res.status(400).json({ error: 'A campanha não tem etapas.' });

    const jobIds = [];
    const baseDate = new Date(startDate + 'T00:00:00');

    for (const step of steps) {
      const sendDate = new Date(baseDate);
      sendDate.setDate(sendDate.getDate() + (step.dayOffset || 0));
      const [h, m] = (step.time || '09:00').split(':').map(Number);
      sendDate.setHours(h, m, 0, 0);

      const job = {
        id: crypto.randomUUID(), status: 'agendada', type: step.type,
        groupIds, groupNames,
        text: step.text || null, caption: step.caption || null,
        filePath: step.filePath || null, fileName: step.fileName || null,
        pollQuestion: step.pollQuestion || null,
        pollOptions: step.pollOptions || [],
        allowMultiple: !!step.allowMultiple,
        mentionAll: !!step.mentionAll, humanize: step.humanize !== false,
        repeat: 'nenhuma',
        sendAt: sendDate.toISOString(),
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
      stepCount: steps.length, jobIds,
      launchedAt: new Date().toISOString()
    };
    store.addLaunch(launch);

    res.json({ ok: true, launch, jobCount: jobIds.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Histórico de lançamentos =====
app.get('/api/launches', (req, res) => res.json(store.listLaunches()));

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
  wa.initialize();
  scheduler.start();
});

// store.js — persistência em arquivo JSON (jobs, campanhas, lançamentos)
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const OLD_FILE = path.join(DATA_DIR, 'jobs.json');

let cache = null;

function load() {
  if (cache) return cache;
  // Migra do antigo jobs.json se existir
  try {
    if (!fs.existsSync(DB_FILE) && fs.existsSync(OLD_FILE)) {
      const old = JSON.parse(fs.readFileSync(OLD_FILE, 'utf8'));
      cache = { jobs: old.jobs || [], campaigns: [], launches: [] };
      save();
      return cache;
    }
    cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  if (!cache.jobs) cache.jobs = [];
  if (!cache.campaigns) cache.campaigns = [];
  if (!cache.launches) cache.launches = [];
  return cache;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

module.exports = {
  // ---------- Jobs ----------
  listJobs() { return load().jobs.slice().sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt)); },
  getJob(id) { return load().jobs.find(j => j.id === id) || null; },
  addJob(job) { load().jobs.push(job); save(); return job; },
  updateJob(id, patch) {
    const j = this.getJob(id); if (!j) return null;
    Object.assign(j, patch, { updatedAt: new Date().toISOString() }); save(); return j;
  },
  removeJob(id) {
    const db = load(); const i = db.jobs.findIndex(j => j.id === id);
    if (i === -1) return false; db.jobs.splice(i, 1); save(); return true;
  },
  // Quantos jobs (exceto exceptJobId) e etapas de campanha usam este arquivo
  // (olha tanto o filePath único quanto a lista files de mensagens multi-arquivo)
  countFileRefs(filePath, exceptJobId) {
    if (!filePath) return 0;
    const db = load();
    const usa = e => e.filePath === filePath || (e.files || []).some(f => f.filePath === filePath);
    let n = 0;
    for (const j of db.jobs) if (j.id !== exceptJobId && usa(j)) n++;
    for (const c of db.campaigns) for (const s of (c.steps || [])) if (usa(s)) n++;
    return n;
  },

  // ---------- Campanhas ----------
  listCampaigns() { return load().campaigns.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR')); },
  getCampaign(id) { return load().campaigns.find(c => c.id === id) || null; },
  addCampaign(c) { load().campaigns.push(c); save(); return c; },
  updateCampaign(id, patch) {
    const c = this.getCampaign(id); if (!c) return null;
    Object.assign(c, patch, { updatedAt: new Date().toISOString() }); save(); return c;
  },
  removeCampaign(id) {
    const db = load(); const i = db.campaigns.findIndex(c => c.id === id);
    if (i === -1) return false; db.campaigns.splice(i, 1); save(); return true;
  },

  // ---------- Lançamentos (histórico) ----------
  listLaunches() { return load().launches.slice().sort((a, b) => new Date(b.launchedAt) - new Date(a.launchedAt)); },
  addLaunch(l) { load().launches.push(l); save(); return l; },
};

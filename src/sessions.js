// sessions.js — tokens de login persistidos em disco.
// Sem isso, cada restart/redeploy do servidor deslogava todo mundo,
// mesmo com o cookie ainda válido no navegador.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'sessions.json');
const TTL_MS = 7 * 24 * 3600 * 1000; // mesmo prazo do cookie zg_token

let sessions = null; // { token: expiraEmMs }

function load() {
  if (sessions) return sessions;
  try {
    sessions = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    sessions = {};
  }
  prune();
  return sessions;
}

function prune() {
  const now = Date.now();
  for (const [token, exp] of Object.entries(sessions)) {
    if (!(exp > now)) delete sessions[token];
  }
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sessions));
  fs.renameSync(tmp, FILE);
}

module.exports = {
  TTL_MS,
  add(token) {
    const s = load();
    s[token] = Date.now() + TTL_MS;
    prune();
    save();
  },
  has(token) {
    if (!token) return false;
    return load()[token] > Date.now();
  },
  remove(token) {
    const s = load();
    if (token in s) {
      delete s[token];
      save();
    }
  }
};

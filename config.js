import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.LOCALDOST_HOME || path.join(os.homedir(), '.localdost');
export const CONFIG_FILE = path.join(HOME, 'config.json');

let cache = null;

export function loadConfig() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  if (!cache.keys || typeof cache.keys !== 'object') cache.keys = {};
  if (!Array.isArray(cache.custom)) cache.custom = [];
  return cache;
}

export function saveConfig() {
  const cfg = loadConfig();
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

export function setKey(providerId, key) {
  const cfg = loadConfig();
  if (key) cfg.keys[providerId] = key.trim();
  else delete cfg.keys[providerId];
  saveConfig();
}

/** Env var wins over the saved key, so CI / dotfiles setups work too. */
export function getKey(provider) {
  return (provider.env && process.env[provider.env]) || loadConfig().keys[provider.id] || provider.key || '';
}

export function setting(name, fallback) {
  const v = loadConfig()[name];
  return v === undefined ? fallback : v;
}

export function setSetting(name, value) {
  loadConfig()[name] = value;
  saveConfig();
}

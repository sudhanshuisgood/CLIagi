import { loadConfig, saveConfig, getKey } from './config.js';

/**
 * Built-in free-tier providers. All speak the OpenAI-compatible chat API.
 * Model names change over time: override any list in ~/.localdost/config.json
 * ("models": { "groq": ["..."] }) or use /models <provider> inside the app.
 */
export const BUILTIN = [
  {
    id: 'groq',
    name: 'Groq',
    base: 'https://api.groq.com/openai/v1',
    env: 'GROQ_API_KEY',
    url: 'https://console.groq.com/keys',
    models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: 'GEMINI_API_KEY',
    url: 'https://aistudio.google.com/apikey',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    base: 'https://api.cerebras.ai/v1',
    env: 'CEREBRAS_API_KEY',
    url: 'https://cloud.cerebras.ai',
    models: ['gpt-oss-120b', 'llama-3.3-70b'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (free models)',
    base: 'https://openrouter.ai/api/v1',
    env: 'OPENROUTER_API_KEY',
    url: 'https://openrouter.ai/keys',
    models: ['qwen/qwen3-coder:free', 'deepseek/deepseek-chat-v3.1:free', 'openai/gpt-oss-120b:free'],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    base: 'https://api.mistral.ai/v1',
    env: 'MISTRAL_API_KEY',
    url: 'https://console.mistral.ai/api-keys',
    models: ['mistral-small-latest'],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    base: 'https://integrate.api.nvidia.com/v1',
    env: 'NVIDIA_API_KEY',
    url: 'https://build.nvidia.com',
    models: ['meta/llama-3.3-70b-instruct'],
  },
];

export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

export class ProviderError extends Error {
  constructor(message, { status = 0, retryAfter = 0, body = '', network = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryAfter = retryAfter;
    this.body = body;
    this.network = network;
  }
}

const rid = () => {
  // 9 chars, [a-zA-Z0-9]: the strictest tool-call-id format among providers (Mistral).
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 9; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
};

function parseWaitSeconds(text = '') {
  const m = /try again in\s+(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?/i.exec(text);
  if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  const g = /retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(text);
  if (g) return +g[1];
  return 0;
}

/** Decide what a failure means and how long to rest that provider/model. */
function classify(e) {
  const s = e.status;
  const b = `${e.body || ''} ${e.message || ''}`.toLowerCase();
  if (s === 429 || /rate.?limit|quota|resource.?exhausted|too many requests/.test(b)) {
    const wait = e.retryAfter || parseWaitSeconds(e.body) || (/per day|daily|quota/.test(b) ? 900 : 30);
    return { kind: 'rate', scope: 'slot', wait };
  }
  if (s === 413 || /too large|reduce the length|context.?length|maximum context|too many tokens/.test(b)) {
    return { kind: 'large' };
  }
  if (s === 401 || s === 403) return { kind: 'auth', scope: 'provider', wait: 1800 };
  if (s === 404 || /model.*(not found|does not exist|decommissioned|deprecated)/.test(b)) {
    return { kind: 'model', scope: 'slot', wait: 3600 };
  }
  if (s === 400 || s === 422) {
    return { kind: 'bad', scope: 'slot', wait: /tool|function/.test(b) ? 1800 : 300 };
  }
  if (e.network || s >= 500 || s === 408) {
    return { kind: 'server', scope: e.network ? 'provider' : 'slot', wait: 20 };
  }
  return { kind: 'other', scope: 'slot', wait: 60 };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** One streaming chat request against one (provider, model). Throws ProviderError on failure. */
export async function streamSlot(slot, messages, tools, signal, onText) {
  const ctrl = new AbortController();
  const relay = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) throw new AbortError();
    signal.addEventListener('abort', relay, { once: true });
  }
  let timer;
  let timedOut = false;
  let printed = false;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, ms);
  };

  try {
    arm(45000);
    const body = { model: slot.model, messages, stream: true, temperature: 0.2 };
    if (tools?.length) body.tools = tools;
    const res = await fetch(slot.provider.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${slot.key}`,
        'HTTP-Referer': 'https://github.com/local-dost',
        'X-Title': 'Local Dost',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`HTTP ${res.status}`, {
        status: res.status,
        body: text.slice(0, 2000),
        retryAfter: Number(res.headers.get('retry-after')) || 0,
      });
    }

    let content = '';
    const calls = [];
    const emit = (t) => {
      content += t;
      printed = true;
      onText?.(t);
    };

    if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const j = await res.json();
      const m = j.choices?.[0]?.message || {};
      if (m.content) emit(m.content);
      for (const tc of m.tool_calls || []) {
        calls.push({ name: tc.function?.name, args: tc.function?.arguments ?? '' });
      }
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        arm(60000);
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let j;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          if (j.error) {
            throw new ProviderError(j.error.message || 'stream error', {
              status: Number(j.error.code) || 500,
              body: JSON.stringify(j.error),
            });
          }
          const d = j.choices?.[0]?.delta;
          if (!d) continue;
          if (d.content) emit(d.content);
          for (const tc of d.tool_calls || []) {
            let i = tc.index;
            if (tc.id && (i === undefined || (calls[i]?.id && calls[i].id !== tc.id))) i = calls.length;
            if (i === undefined) i = Math.max(0, calls.length - 1);
            const c = (calls[i] ||= { id: tc.id || '', name: '', args: '' });
            if (tc.id) c.id = tc.id;
            if (tc.function?.name && !c.name) c.name = tc.function.name;
            if (tc.function?.arguments != null) {
              c.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
            }
          }
        }
      }
    }

    const tool_calls = calls
      .filter((c) => c && c.name)
      .map((c) => ({ id: rid(), type: 'function', function: { name: c.name, arguments: c.args || '{}' } }));

    if (!content.trim() && !tool_calls.length) {
      throw new ProviderError('empty response', { status: 502 });
    }
    return { content, tool_calls };
  } catch (e) {
    let err = e;
    if (signal?.aborted) err = new AbortError();
    else if (timedOut) err = new ProviderError('timeout', { network: true });
    else if (!(e instanceof ProviderError)) err = new ProviderError(e.message || String(e), { network: true });
    err.printed = printed;
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

/**
 * Picks a provider, streams, and on ANY failure quietly moves to the next one.
 * Rate-limited slots rest for as long as the provider says; if everything is resting,
 * it waits (with a friendly spinner label) instead of erroring.
 */
export class Router {
  constructor() {
    this.cool = new Map(); // slot id or "p:<provider>" -> timestamp (ms) until usable
    this.current = null;
    this.ollama = [];
  }

  async detectOllama() {
    try {
      const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(600) });
      const j = await r.json();
      const names = (j.models || []).map((m) => m.name);
      names.sort((a, b) => Number(/coder/i.test(b)) - Number(/coder/i.test(a)));
      this.ollama = names.slice(0, 2);
    } catch {
      this.ollama = [];
    }
  }

  providers() {
    const cfg = loadConfig();
    const list = BUILTIN.map((p) => ({ ...p, models: cfg.models?.[p.id] || p.models }));
    for (const c of cfg.custom || []) {
      if (!c?.id || !c?.base) continue;
      list.push({
        id: c.id,
        name: c.name || c.id,
        base: c.base,
        key: c.key,
        env: c.env,
        models: cfg.models?.[c.id] || c.models || [c.model].filter(Boolean),
        custom: true,
        nokey: !c.key && !c.env,
      });
    }
    if (this.ollama.length) {
      list.push({ id: 'ollama', name: 'Ollama (local, unlimited)', base: 'http://localhost:11434/v1', nokey: true, models: this.ollama });
    }
    const order = cfg.order || [];
    const rank = (p) => (order.indexOf(p.id) < 0 ? 999 : order.indexOf(p.id));
    return list.sort((a, b) => rank(a) - rank(b));
  }

  slots() {
    const out = [];
    for (const p of this.providers()) {
      const key = p.nokey ? 'none' : getKey(p);
      if (!key) continue;
      for (const model of p.models) out.push({ id: `${p.id}/${model}`, provider: p, model, key });
    }
    return out;
  }

  until(slot) {
    return Math.max(this.cool.get(slot.id) || 0, this.cool.get('p:' + slot.provider.id) || 0);
  }

  rest(slot, scope, seconds) {
    this.cool.set(scope === 'provider' ? 'p:' + slot.provider.id : slot.id, Date.now() + seconds * 1000);
  }

  status(provider) {
    const key = provider.nokey ? 'none' : getKey(provider);
    if (!key) return { text: 'no key', ok: false };
    const now = Date.now();
    const t = Math.max(this.cool.get('p:' + provider.id) || 0, ...provider.models.map((m) => this.cool.get(`${provider.id}/${m}`) || 0));
    if (t > now) return { text: `resting ${Math.ceil((t - now) / 1000)}s`, ok: true };
    return { text: 'ready', ok: true };
  }

  /** Move a provider (and optionally a model) to the front of the queue. */
  prefer(providerId, model) {
    const cfg = loadConfig();
    const ids = this.providers().map((p) => p.id).filter((id) => id !== providerId);
    cfg.order = [providerId, ...ids];
    if (model) {
      const p = this.providers().find((x) => x.id === providerId);
      cfg.models = cfg.models || {};
      cfg.models[providerId] = [model, ...(p?.models || []).filter((m) => m !== model)];
    }
    saveConfig();
    this.current = null;
  }

  async chat({ build, tools, signal, onText, onRestart, onSlot, onWait }) {
    let level = 0;
    for (;;) {
      if (signal?.aborted) throw new AbortError();
      const all = this.slots();
      if (!all.length) {
        const e = new Error('NO_PROVIDERS');
        e.code = 'NO_PROVIDERS';
        throw e;
      }
      const now = Date.now();
      const ready = all.filter((s) => this.until(s) <= now);
      if (!ready.length) {
        const next = Math.min(...all.map((s) => this.until(s)));
        if (next - now > 6 * 60 * 1000) return { exhausted: true, until: next };
        const end = next;
        while (Date.now() < end) {
          onWait?.(Math.ceil((end - Date.now()) / 1000));
          await sleep(Math.min(1000, Math.max(50, end - Date.now())), signal);
        }
        continue;
      }
      ready.sort((a, b) => Number(b.id === this.current) - Number(a.id === this.current));
      const slot = ready[0];
      try {
        onSlot?.(slot);
        const out = await streamSlot(slot, build(level), tools, signal, onText);
        this.current = slot.id;
        return { ...out, slot };
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        const c = classify(e);
        if (c.kind === 'large') {
          if (level < 3) {
            level++;
          } else {
            this.rest(slot, 'slot', 30);
          }
        } else {
          this.rest(slot, c.scope, c.wait);
        }
        if (e.printed) onRestart?.();
      }
    }
  }

  /** Tiny non-streaming health check used by `localdost doctor`. */
  async ping(slot) {
    try {
      await streamSlot(slot, [{ role: 'user', content: 'Reply with the single word: ok' }], null, AbortSignal.timeout(30000), null);
      return { ok: true };
    } catch (e) {
      const c = classify(e);
      const why = {
        rate: 'rate limited (key works, quota is used up for now)',
        auth: 'key rejected',
        model: 'model not found: pick another with /models',
        bad: 'request rejected',
        server: 'provider unreachable / server error',
      }[c.kind] || e.message;
      return { ok: c.kind === 'rate', why, status: e.status };
    }
  }

  async listModels(provider) {
    const key = provider.nokey ? 'none' : getKey(provider);
    const r = await fetch(provider.base.replace(/\/$/, '') + '/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return (j.data || j.models || []).map((m) => String(m.id || m.name).replace(/^models\//, '')).sort();
  }
}

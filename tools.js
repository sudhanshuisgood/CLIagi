import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { red, green, dim } from './ui.js';

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', '.cache', 'coverage']);
const SENSITIVE = /(^|[\\/])(\.env(\.(?!example$|sample$|template$)[^\\/]*)?|id_rsa|id_ed25519|[^\\/]*\.pem|[^\\/]*\.key|\.npmrc|\.netrc|credentials)$/i;
const DANGEROUS = /\brm\s+-[a-z]*(rf|fr)\b|\bsudo\b|\bmkfs\b|\bdd\s+if=|>\s*\/dev\/sd|\bshutdown\b|\breboot\b|:\(\)\s*\{|\bchmod\s+-R\s+777|(curl|wget)[^|]*\|\s*(ba|z)?sh|\bgit\s+push\b.*--force|\bgit\s+reset\s+--hard|\bformat\s+[a-z]:/i;
const MAX_OUT = 16000;

const clip = (s, n = MAX_OUT) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s);
const good = (output, summary) => ({ output, summary: summary ?? output.split('\n')[0] });
const bad = (msg) => ({ output: `Error: ${msg}`, summary: msg, error: true });
const denied = () => ({ output: 'The user denied permission for this action. Do not retry it; ask what they would like instead.', summary: 'denied by user', error: true });

function fn(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

export const DEFS = [
  fn('read_file', 'Read a text file. Returns numbered lines. Use offset/limit for big files.', {
    path: { type: 'string' },
    offset: { type: 'integer', description: '1-based first line (default 1)' },
    limit: { type: 'integer', description: 'max lines (default 400)' },
  }, ['path']),
  fn('list_dir', 'List files and folders in a directory.', { path: { type: 'string', description: 'default: project root' } }),
  fn('find_files', 'Find files by glob pattern, e.g. "**/*.js" or "*.md".', {
    pattern: { type: 'string' },
    path: { type: 'string', description: 'folder to search (default: project root)' },
  }, ['pattern']),
  fn('search_text', 'Search file contents with a regular expression (like grep).', {
    pattern: { type: 'string' },
    path: { type: 'string' },
    include: { type: 'string', description: 'glob filter, e.g. "*.ts"' },
    ignore_case: { type: 'boolean' },
  }, ['pattern']),
  fn('write_file', 'Create a new file or fully overwrite one. Prefer edit_file for changes to existing files.', {
    path: { type: 'string' },
    content: { type: 'string' },
  }, ['path', 'content']),
  fn('edit_file', 'Replace an exact string in a file. old_string must match exactly (including indentation) and be unique unless replace_all is true.', {
    path: { type: 'string' },
    old_string: { type: 'string' },
    new_string: { type: 'string' },
    replace_all: { type: 'boolean' },
  }, ['path', 'old_string', 'new_string']),
  fn('run_command', 'Run a shell command in the project folder (tests, builds, git, etc.). Returns combined output.', {
    command: { type: 'string' },
    timeout_seconds: { type: 'integer', description: 'default 120, max 600' },
  }, ['command']),
];

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > 0) {
        re += '(?:' + glob.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
      } else re += '\\{';
    } else re += c.replace(/[.+^$()|[\]\\}]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

function* walk(root, depth = 0) {
  if (depth > 12) return;
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  ents.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of ents) {
    if (IGNORE.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (e.isFile()) yield full;
  }
}

function lineDiff(oldS, newS, max = 12) {
  const o = oldS.split('\n');
  const n = newS.split('\n');
  let s = 0;
  while (s < o.length && s < n.length && o[s] === n[s]) s++;
  let eo = o.length;
  let en = n.length;
  while (eo > s && en > s && o[eo - 1] === n[en - 1]) {
    eo--;
    en--;
  }
  const out = o.slice(Math.max(0, s - 2), s).map((l) => dim('  ' + l));
  const rem = o.slice(s, eo);
  const add = n.slice(s, en);
  rem.slice(0, max).forEach((l) => out.push(red('- ' + l)));
  if (rem.length > max) out.push(dim(`  … ${rem.length - max} more lines removed`));
  add.slice(0, max).forEach((l) => out.push(green('+ ' + l)));
  if (add.length > max) out.push(dim(`  … ${add.length - max} more lines added`));
  return out;
}

const addedPreview = (content, max = 12) => {
  const lines = content.split('\n');
  const out = lines.slice(0, max).map((l) => green('+ ' + l));
  if (lines.length > max) out.push(dim(`  … ${lines.length - max} more lines`));
  return out;
};

/**
 * ctx = { cwd, signal(): AbortSignal|undefined,
 *         review({kind,title,preview,force,danger}): Promise<boolean> }
 */
export function createTools(ctx) {
  const undoStack = [];
  const abs = (p) => path.resolve(ctx.cwd, String(p ?? '.'));
  const rel = (a) => path.relative(ctx.cwd, a) || '.';
  const outside = (a) => {
    const r = path.relative(ctx.cwd, a);
    return r.startsWith('..') || path.isAbsolute(r);
  };

  const impl = {
    async read_file({ path: p, offset = 1, limit = 400 }) {
      const a = abs(p);
      const secret = SENSITIVE.test(a);
      if (secret || outside(a)) {
        const okay = await ctx.review({
          kind: 'read',
          title: `Read ${rel(a)}`,
          preview: [secret ? '⚠ looks like a secrets file: its contents would be sent to the AI provider' : 'outside the project folder'],
          force: true,
        });
        if (!okay) return denied();
      }
      let st;
      try {
        st = fs.statSync(a);
      } catch {
        return bad(`file not found: ${rel(a)}`);
      }
      if (st.isDirectory()) return bad(`${rel(a)} is a directory; use list_dir`);
      if (st.size > 2_000_000) return bad(`file is too large (${st.size} bytes); use search_text or offset/limit`);
      const raw = fs.readFileSync(a);
      if (raw.includes(0)) return bad('binary file');
      const lines = raw.toString('utf8').split('\n');
      const start = Math.max(1, offset | 0);
      const slice = lines.slice(start - 1, start - 1 + Math.max(1, limit | 0));
      const body = slice.map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join('\n');
      const more = start - 1 + slice.length < lines.length ? `\n…[${lines.length - (start - 1 + slice.length)} more lines; use offset=${start + slice.length}]` : '';
      return good(clip(body) + more, `Read ${slice.length} lines`);
    },

    async list_dir({ path: p = '.' }) {
      const a = abs(p);
      let ents;
      try {
        ents = fs.readdirSync(a, { withFileTypes: true });
      } catch {
        return bad(`cannot list ${rel(a)}`);
      }
      ents.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
      const lines = ents.slice(0, 200).map((e) => (e.isDirectory() ? e.name + '/' : e.name));
      return good(lines.join('\n') || '(empty)', `Listed ${ents.length} entries`);
    },

    async find_files({ pattern, path: p = '.' }) {
      const root = abs(p);
      const re = globToRegex(pattern);
      const hasSlash = pattern.includes('/');
      const hits = [];
      for (const f of walk(root)) {
        const r = path.relative(root, f).split(path.sep).join('/');
        if (re.test(hasSlash ? r : path.basename(f))) hits.push(rel(f));
        if (hits.length >= 200) break;
      }
      return good(hits.join('\n') || 'No files matched.', `Found ${hits.length} files`);
    },

    async search_text({ pattern, path: p = '.', include, ignore_case }) {
      let re;
      try {
        re = new RegExp(pattern, ignore_case ? 'i' : '');
      } catch (e) {
        return bad(`invalid regex: ${e.message}`);
      }
      const inc = include ? globToRegex(include) : null;
      const root = abs(p);
      const files = fs.existsSync(root) && fs.statSync(root).isFile() ? [root] : walk(root);
      const hits = [];
      outer: for (const f of files) {
        if (inc && !inc.test(path.basename(f))) continue;
        let st;
        try {
          st = fs.statSync(f);
        } catch {
          continue;
        }
        if (st.size > 1_000_000) continue;
        const buf = fs.readFileSync(f);
        if (buf.includes(0)) continue;
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${rel(f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= 100) break outer;
          }
        }
      }
      return good(hits.join('\n') || 'No matches.', `${hits.length} matches`);
    },

    async write_file({ path: p, content }) {
      if (typeof content !== 'string') return bad('content must be a string');
      const a = abs(p);
      const existed = fs.existsSync(a);
      const prev = existed ? fs.readFileSync(a, 'utf8') : null;
      const lines = content.split('\n').length;
      const okay = await ctx.review({
        kind: 'edit',
        title: `${existed ? 'Overwrite' : 'Create'} ${rel(a)}`,
        preview: existed ? lineDiff(prev, content) : addedPreview(content),
        force: outside(a),
      });
      if (!okay) return denied();
      fs.mkdirSync(path.dirname(a), { recursive: true });
      fs.writeFileSync(a, content);
      undoStack.push({ a, existed, prev });
      return good(`Wrote ${rel(a)} (${lines} lines).`, `${existed ? 'Updated' : 'Created'} ${rel(a)} (${lines} lines)`);
    },

    async edit_file({ path: p, old_string, new_string, replace_all = false }) {
      const a = abs(p);
      if (!fs.existsSync(a)) return bad(`file not found: ${rel(a)} (use write_file to create it)`);
      if (typeof old_string !== 'string' || typeof new_string !== 'string') return bad('old_string and new_string must be strings');
      if (old_string === new_string) return bad('old_string and new_string are identical');
      if (!old_string) return bad('old_string is empty');
      const prev = fs.readFileSync(a, 'utf8');
      const crlf = prev.includes('\r\n');
      const fix = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
      const oldS = prev.includes(old_string) ? old_string : fix(old_string);
      const newS = prev.includes(old_string) ? new_string : fix(new_string);
      const count = prev.split(oldS).length - 1;
      if (count === 0) return bad('old_string was not found. Re-read the file and copy the exact text, including whitespace.');
      if (count > 1 && !replace_all) return bad(`old_string matches ${count} places. Add more surrounding context or set replace_all=true.`);
      const next = replace_all ? prev.split(oldS).join(newS) : prev.replace(oldS, () => newS);
      const okay = await ctx.review({
        kind: 'edit',
        title: `Edit ${rel(a)}`,
        preview: lineDiff(prev, next),
        force: outside(a),
      });
      if (!okay) return denied();
      fs.writeFileSync(a, next);
      undoStack.push({ a, existed: true, prev });
      return good(`Edited ${rel(a)} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? 's' : ''}).`, `Edited ${rel(a)}`);
    },

    async run_command({ command, timeout_seconds = 120 }) {
      if (typeof command !== 'string' || !command.trim()) return bad('command is empty');
      const danger = DANGEROUS.test(command);
      const first = command.trim().split(/\s+/)[0];
      const okay = await ctx.review({ kind: 'cmd:' + first, title: `Run: ${command}`, preview: danger ? ['⚠ potentially destructive command'] : [], danger, force: danger });
      if (!okay) return denied();
      const limit = Math.min(Math.max(Number(timeout_seconds) || 120, 1), 600) * 1000;
      return await new Promise((resolve) => {
        const child = spawn(command, { shell: true, cwd: ctx.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        let out = '';
        const add = (d) => {
          out += d.toString();
          if (out.length > 400000) out = out.slice(-200000);
        };
        child.stdout.on('data', add);
        child.stderr.on('data', add);
        let killed = '';
        const kill = (why) => {
          killed = why;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 2000).unref();
        };
        const t = setTimeout(() => kill('timed out'), limit);
        const sig = ctx.signal?.();
        const onAbort = () => kill('interrupted');
        sig?.addEventListener('abort', onAbort, { once: true });
        child.on('error', (e) => {
          clearTimeout(t);
          resolve(bad(e.message));
        });
        child.on('close', (code) => {
          clearTimeout(t);
          sig?.removeEventListener('abort', onAbort);
          const text = out.length > MAX_OUT ? out.slice(0, 4000) + '\n…[output truncated]…\n' + out.slice(-(MAX_OUT - 4000)) : out;
          const status = killed ? killed : `exit code ${code}`;
          resolve({
            output: `${status}\n${text}`.trim(),
            summary: `${status}${out.trim() ? ' · ' + out.trim().split('\n').length + ' lines of output' : ''}`,
            error: code !== 0,
          });
        });
      });
    },
  };

  return {
    defs: DEFS,
    async run(name, args) {
      const f = impl[name];
      if (!f) return bad(`unknown tool "${name}"`);
      try {
        return await f(args || {});
      } catch (e) {
        return bad(e.message || String(e));
      }
    },
    undo() {
      const last = undoStack.pop();
      if (!last) return null;
      if (last.existed) fs.writeFileSync(last.a, last.prev);
      else fs.rmSync(last.a, { force: true });
      return `${last.existed ? 'Restored' : 'Removed'} ${rel(last.a)}`;
    },
    canUndo: () => undoStack.length,
  };
}

export const describeCall = (name, a = {}) => {
  const short = (s, n = 70) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return short(a.path ?? '');
    case 'list_dir':
      return short(a.path ?? '.');
    case 'find_files':
      return short(a.pattern ?? '');
    case 'search_text':
      return short(a.pattern ?? '');
    case 'run_command':
      return short(a.command ?? '');
    default:
      return '';
  }
};

export const toolLabel = (name) =>
  ({ read_file: 'Read', list_dir: 'List', find_files: 'Find', search_text: 'Search', write_file: 'Write', edit_file: 'Edit', run_command: 'Run' })[name] || name;

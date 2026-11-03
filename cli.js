import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';
import { loadConfig, setKey, setSetting, CONFIG_FILE } from './config.js';
import { Router, BUILTIN } from './providers.js';
import { createTools } from './tools.js';
import { Agent } from './agent.js';
import * as ui from './ui.js';

const { cyan, bcyan, bold, dim, green, red, yellow } = ui;

const HELP = `
${bold('Local Dost')} ${dim('v' + VERSION)}: free-tier AI coding agent for your terminal

${bold('Usage')}
  localdost                  start an interactive session in the current folder
  localdost "fix the bug"    start with a first request
  localdost -p "request"     one-shot: print the answer and exit
  localdost setup            add or change your free API keys
  localdost doctor           test every configured provider
  localdost update           update to the latest version

${bold('Options')}
  -y, --yolo     auto-approve file edits and commands (dangerous commands still ask)
  -v, --version  print version
  -h, --help     show this help
`;

function parseArgs(argv) {
  const o = { yolo: false, print: null, initial: null, cmd: null, version: false, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-v' || a === '--version') o.version = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-y' || a === '--yolo') o.yolo = true;
    else if (a === '-p' || a === '--print') {
      const parts = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) parts.push(argv[++i]);
      o.print = parts.join(' ');
    } else rest.push(a);
  }
  if (['setup', 'doctor', 'update'].includes(rest[0]) && o.print === null) o.cmd = rest.shift();
  if (rest.length && o.print === null) o.initial = rest.join(' ');
  return o;
}

/** readline wrapper that works for both a real terminal and piped stdin. */
function makeInput() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const queue = [];
  let waiter = null;
  let closed = false;
  let muted = false;
  const origWrite = rl._writeToOutput?.bind(rl);
  if (origWrite) {
    rl._writeToOutput = (s) => {
      if (muted) rl.output.write(s.includes('\n') || s.includes('\r') ? s : '*'.repeat(Math.min(s.length, 1)));
      else origWrite(s);
    };
  }
  rl.on('line', (l) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      muted = false;
      w(l);
    } else queue.push(l);
  });
  rl.on('close', () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  return {
    rl,
    ask(prompt, { mask = false } = {}) {
      return new Promise((resolve) => {
        if (queue.length) return resolve(queue.shift());
        if (closed) return resolve(null);
        waiter = resolve;
        rl.setPrompt(prompt);
        rl.prompt();
        muted = mask && Boolean(process.stdin.isTTY);
      });
    },
    close: () => rl.close(),
    get closed() {
      return closed;
    },
  };
}

async function setup(input, router) {
  console.log(`\n${bold('Set up free AI providers')}`);
  console.log(dim('All of these have a free tier. Most need no credit card. Add 2–3 so Local Dost can switch\nautomatically when one runs out. Press Enter to skip any.\n'));
  for (const p of BUILTIN) {
    const has = Boolean(loadConfig().keys[p.id] || (p.env && process.env[p.env]));
    console.log(`${cyan('●')} ${bold(p.name)} ${has ? green('(key saved)') : ''}\n  ${dim('get a free key:')} ${p.url}`);
    const v = await input.ask(`  ${cyan('›')} paste key${has ? ' (Enter keeps current)' : ''}: `, { mask: true });
    if (v === null) break;
    if (v.trim()) {
      setKey(p.id, v.trim());
      console.log(`  ${green('✔ saved')}`);
    }
  }
  console.log(`\n${green('✔')} Done. Keys are stored in ${dim(CONFIG_FILE)} (owner-only permissions).`);
  console.log(dim('  Tip: run `localdost doctor` to test your keys.\n'));
}

async function doctor(router) {
  await router.detectOllama();
  const provs = router.providers();
  console.log(`\n${bold('Provider check')}\n`);
  let working = 0;
  for (const p of provs) {
    const slots = router.slots().filter((s) => s.provider.id === p.id);
    if (!slots.length) {
      console.log(`  ${dim('○')} ${p.name.padEnd(28)} ${dim('no key · ' + (p.url || ''))}`);
      continue;
    }
    for (const s of slots) {
      const r = await router.ping(s);
      if (r.ok) working++;
      console.log(`  ${r.ok ? green('✔') : red('✖')} ${(p.id + '/' + s.model).padEnd(46)} ${r.ok ? dim(r.why ? 'ok · ' + r.why : 'ok') : yellow(r.why)}`);
    }
  }
  console.log(
    working >= 2
      ? `\n${green('✔')} ${working} models ready. Automatic failover is on.\n`
      : `\n${yellow('!')} Only ${working} working. Add more keys with ${bold('localdost setup')} for seamless failover.\n`,
  );
}

function update() {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (fs.existsSync(path.join(appDir, '.git'))) {
    const r = spawnSync('git', ['-C', appDir, 'pull', '--ff-only'], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  }
  console.log('Re-run the install command from the README to update (it is safe to run again).');
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.version) return console.log(VERSION);
  if (opts.help) return console.log(HELP);
  if (opts.cmd === 'update') return update();

  const router = new Router();
  if (opts.cmd === 'doctor') return doctor(router);

  const input = makeInput();
  if (opts.cmd === 'setup') {
    await setup(input, router);
    return input.close();
  }

  await router.detectOllama();
  const config = loadConfig();
  const cwd = process.cwd();
  const state = { yolo: opts.yolo || Boolean(config.yolo), always: new Set(), signal: null, running: false, sigints: 0 };

  async function review({ kind, title, preview = [], force = false, danger = false }) {
    console.log(`\n${cyan('╭')} ${bold(title)}`);
    for (const l of preview) console.log(`${cyan('│')} ${l}`);
    const auto = !force && !danger && (state.yolo || state.always.has(kind));
    if (auto) {
      console.log(`${cyan('╰')} ${dim(state.yolo ? 'auto-approved (yolo)' : 'approved for this session')}`);
      return true;
    }
    if (opts.print !== null && !process.stdin.isTTY) {
      console.log(`${cyan('╰')} ${dim('denied (non-interactive run). Use --yolo to auto-approve.')}`);
      return false;
    }
    const ans = await input.ask(`${cyan('╰')} Allow? ${dim('[y]es · [a]lways this session · [n]o')} ${cyan('›')} `);
    if (ans === null) {
      console.log(dim('  (no interactive input: denied. Use --yolo to auto-approve in scripts.)'));
      return false;
    }
    const a = ans.trim().toLowerCase();
    if (a === 'a' || a === 'always') {
      if (!force && !danger) state.always.add(kind);
      return true;
    }
    return a === 'y' || a === 'yes' || a === '';
  }

  const tools = createTools({ cwd, signal: () => state.signal, review });
  const agent = new Agent({ router, tools, cwd, config });

  async function turn(text) {
    const ctrl = new AbortController();
    state.signal = ctrl.signal;
    state.abort = () => ctrl.abort();
    state.running = true;
    try {
      await agent.run(text, ctrl.signal);
    } catch (e) {
      if (e.name === 'AbortError') console.log(`\n${dim('  ⎿  Interrupted')}`);
      else if (e.code === 'NO_PROVIDERS') {
        console.log(`\n${yellow('●')} No AI provider is set up yet.`);
        console.log(dim('  Run /keys here (or `localdost setup`) and paste at least one free key.'));
      } else console.log(`\n${yellow('●')} Something went wrong locally: ${e.message}`);
    } finally {
      state.running = false;
      state.signal = null;
    }
  }

  const onSigint = () => {
    if (state.running) {
      state.abort?.();
      return;
    }
    if (++state.sigints >= 2) {
      console.log(`\n${dim('  bye, dost 👋')}\n`);
      process.exit(0);
    }
    console.log(`\n${dim('  Press Ctrl+C again to exit (or type /exit)')}`);
    setTimeout(() => (state.sigints = 0), 2000).unref();
  };
  input.rl.on('SIGINT', onSigint);
  process.on('SIGINT', onSigint);

  // ---------- one-shot mode ----------
  if (opts.print !== null) {
    if (!opts.print.trim()) {
      console.error('Usage: localdost -p "your request"');
      process.exit(1);
    }
    await turn(opts.print);
    console.log();
    input.close();
    process.exit(0);
  }

  // ---------- interactive ----------
  const names = router.slots().length ? [...new Set(router.slots().map((s) => s.provider.id))].join(' · ') : 'no provider yet';
  console.log('\n' + ui.logo() + '\n');
  console.log(
    ui.box(
      [
        `${bold('Free-tier AI coding agent')} ${dim('· open source · runs locally')}`,
        `${dim('folder')}  ${ui.tildify(cwd)}`,
        `${dim('brains')}  ${names}${state.yolo ? ' ' + yellow('· yolo') : ''}`,
        `${dim('tips  ')}  /help · /providers · /keys · /yolo · /undo`,
      ],
      bold(bcyan('Local Dost')) + dim(' v' + VERSION),
    ),
  );

  if (!router.slots().length && process.stdin.isTTY) await setup(input, router);

  async function command(line) {
    const [cmd, ...args] = line.slice(1).trim().split(/\s+/);
    switch ((cmd || '').toLowerCase()) {
      case 'help':
      case '?':
        console.log(`
  ${cyan('/help')}                 show this
  ${cyan('/providers')}            show providers, models and their status
  ${cyan('/keys')}                 add or change API keys
  ${cyan('/model')} <prov[/model]> prefer a provider (or exact model) first
  ${cyan('/models')} <provider>    list models a provider offers
  ${cyan('/yolo')}                 toggle auto-approve for edits and commands
  ${cyan('/undo')}                 undo the last file change
  ${cyan('/init')}                 let the AI write LOCALDOST.md (project notes)
  ${cyan('/clear')}                clear conversation and screen
  ${cyan('/exit')}                 quit
  ${dim('!<cmd>')}                 run a shell command yourself, e.g. ${dim('!git status')}
  ${dim('end a line with \\ for multi-line input')}`);
        break;
      case 'providers':
      case 'status': {
        console.log();
        for (const p of router.providers()) {
          const st = router.status(p);
          const mark = st.ok ? (st.text === 'ready' ? green('●') : yellow('●')) : dim('○');
          console.log(`  ${mark} ${p.name.padEnd(28)} ${dim(st.text.padEnd(14))} ${dim(p.models.join(', '))}`);
        }
        console.log(dim(`\n  config: ${CONFIG_FILE}`));
        break;
      }
      case 'keys':
        await setup(input, router);
        break;
      case 'model': {
        if (!args[0]) {
          console.log(`  current: ${cyan(router.current || 'auto')}`);
          break;
        }
        const [pid, ...m] = args[0].split('/');
        const p = router.providers().find((x) => x.id === pid);
        if (!p) {
          console.log(yellow(`  unknown provider "${pid}". Try /providers`));
          break;
        }
        router.prefer(pid, m.join('/') || undefined);
        console.log(`  ${green('✔')} ${pid}${m.length ? '/' + m.join('/') : ''} is now tried first (others stay as backup)`);
        break;
      }
      case 'models': {
        const p = router.providers().find((x) => x.id === args[0]);
        if (!p) {
          console.log(yellow('  usage: /models <provider>   (see /providers)'));
          break;
        }
        try {
          const list = await router.listModels(p);
          console.log(list.map((x) => '  ' + x).join('\n'));
          console.log(dim(`\n  use one with: /model ${p.id}/<model>`));
        } catch (e) {
          console.log(yellow(`  could not fetch the list (${e.message}). Is the key set?`));
        }
        break;
      }
      case 'yolo':
        state.yolo = !state.yolo;
        setSetting('yolo', state.yolo);
        console.log(state.yolo ? yellow('  yolo ON: edits and commands run without asking (dangerous ones still ask)') : green('  yolo OFF: I will ask before editing or running things'));
        break;
      case 'undo': {
        const r = tools.undo();
        console.log(r ? `  ${green('✔')} ${r}` : dim('  nothing to undo'));
        break;
      }
      case 'clear':
        agent.reset();
        process.stdout.write('\x1b[2J\x1b[H');
        break;
      case 'init':
        await turn('Explore this project and create a concise LOCALDOST.md in the project root: what it is, tech stack, how to run/test/build, folder layout and coding conventions. Keep it under 60 lines.');
        break;
      case 'exit':
      case 'quit':
        console.log(`\n${dim('  bye, dost 👋')}\n`);
        input.close();
        process.exit(0);
        break;
      default:
        console.log(dim(`  unknown command /${cmd}. Try /help`));
    }
  }

  function shell(cmdline) {
    return new Promise((resolve) => {
      const c = spawn(cmdline, { shell: true, cwd, stdio: 'inherit' });
      c.on('close', resolve);
      c.on('error', resolve);
    });
  }

  let first = opts.initial;
  for (;;) {
    let line;
    if (first) {
      line = first;
      first = null;
      console.log(`\n${bcyan('❯')} ${line}`);
    } else {
      console.log(`\n${cyan('─'.repeat(ui.cols()))}`);
      line = await input.ask(`${bcyan('❯')} `);
    }
    if (line === null) break;
    while (line.endsWith('\\')) {
      const more = await input.ask(`${dim('…')} `);
      if (more === null) break;
      line = line.slice(0, -1) + '\n' + more;
    }
    const text = line.trim();
    if (!text) continue;
    state.sigints = 0;
    if (text.startsWith('/')) await command(text);
    else if (text.startsWith('!')) await shell(text.slice(1));
    else await turn(text);
  }
  console.log(`\n${dim('  bye, dost 👋')}\n`);
  process.exit(0);
}

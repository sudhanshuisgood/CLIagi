import os from 'node:os';

const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (open, close) => (s) => (tty ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const isTTY = tty;
export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const bcyan = wrap(96, 39);
export const gray = wrap(90, 39);

export const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
export const tildify = (p) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);
export const cols = () => Math.min(process.stdout.columns || 80, 100);

export function box(lines, title = '') {
  const inner = Math.max(...lines.map((l) => strip(l).length), strip(title).length + 4) + 2;
  const top = title
    ? `${cyan('╭─')} ${title} ${cyan('─'.repeat(Math.max(0, inner - strip(title).length - 3)) + '╮')}`
    : cyan(`╭${'─'.repeat(inner)}╮`);
  const rows = lines.map((l) => `${cyan('│')} ${l}${' '.repeat(inner - 1 - strip(l).length)}${cyan('│')}`);
  return [top, ...rows, cyan(`╰${'─'.repeat(inner)}╯`)].join('\n');
}

const LOGO_LOCAL = [
  String.raw` _     ___   ____    _    _     `,
  String.raw`| |   / _ \ / ___|  / \  | |    `,
  String.raw`| |  | | | | |     / _ \ | |    `,
  String.raw`| |__| |_| | |___ / ___ \| |___ `,
  String.raw`|_____\___/ \____/_/   \_\_____|`,
];
const LOGO_DOST = [
  String.raw` ____   ___  ____ _____ `,
  String.raw`|  _ \ / _ \/ ___|_   _|`,
  String.raw`| | | | | | \___ \ | |  `,
  String.raw`| |_| | |_| |___) || |  `,
  String.raw`|____/ \___/|____/ |_|  `,
];

export function logo() {
  return LOGO_LOCAL.map((l, i) => bcyan(l) + '  ' + cyan(LOGO_DOST[i])).join('\n');
}

export function spinner(label = 'Thinking') {
  if (!tty) return { set() {}, stop() {} };
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  let i = 0;
  let text = label;
  let running = true;
  const t0 = Date.now();
  const draw = () => {
    const secs = Math.floor((Date.now() - t0) / 1000);
    process.stdout.write(
      `\r\x1b[2K${cyan(frames[i++ % frames.length])} ${cyan(text)}${dim(` (${secs}s · ctrl+c to interrupt)`)}`,
    );
  };
  const timer = setInterval(draw, 90);
  draw();
  return {
    set(t) {
      text = t;
    },
    stop() {
      if (!running) return;
      running = false;
      clearInterval(timer);
      process.stdout.write('\r\x1b[2K');
    },
  };
}

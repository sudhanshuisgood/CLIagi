import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AbortError } from './providers.js';
import { describeCall, toolLabel } from './tools.js';
import * as ui from './ui.js';

const MAX_STEPS = 30;

export class Agent {
  constructor({ router, tools, cwd, config }) {
    this.router = router;
    this.tools = tools;
    this.cwd = cwd;
    this.config = config;
    this.messages = [];
    this.lastSlot = null;
  }

  reset() {
    this.messages = [];
  }

  systemPrompt() {
    let tree = '';
    try {
      const ents = fs.readdirSync(this.cwd, { withFileTypes: true }).filter((e) => !e.name.startsWith('.git') && e.name !== 'node_modules');
      tree = ents.slice(0, 40).map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join(', ');
    } catch {}
    let project = '';
    try {
      project = fs.readFileSync(path.join(this.cwd, 'LOCALDOST.md'), 'utf8').slice(0, 4000);
    } catch {}
    return [
      'You are Local Dost ("dost" = friend), a capable, friendly AI coding agent running inside the user\'s terminal. You read, write, debug and refactor code in their project by calling tools.',
      '',
      `Environment: cwd=${this.cwd}; platform=${os.platform()}; date=${new Date().toISOString().slice(0, 10)}`,
      `Top-level files: ${tree || '(empty folder)'}`,
      '',
      'Rules:',
      '- Reply in the language the user writes in (English, Hindi, Hinglish, etc.). Be warm, direct and brief, like a smart friend.',
      '- Explore before you change anything: list_dir, find_files, search_text, read_file. Never guess file contents.',
      '- Make small, targeted changes with edit_file. old_string must match the file exactly. Use write_file only for new files or full rewrites.',
      '- After changing code, verify when practical (run the tests, build or linter with run_command).',
      '- Do not read secrets files (.env, keys) unless the user explicitly asks. Never repeat secrets in your reply.',
      '- If a tool is denied by the user, do not retry it; ask what they prefer.',
      '- Finish with a short summary of what you changed and where. No long essays.',
      project ? `\nProject notes (LOCALDOST.md):\n${project}` : '',
    ].join('\n');
  }

  /** Build the message list for a request, trimmed to fit small free-tier limits. */
  build(level = 0) {
    const budget = Math.floor((this.config.maxContextChars || 48000) / 2 ** level);
    const toolCap = Math.floor(6000 / 2 ** level);
    const sys = { role: 'system', content: this.systemPrompt() };
    const size = (m) => (m.content?.length || 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + 20;

    const msgs = this.messages.map((m, i) => {
      if (m.role !== 'tool') return m;
      const cap = i < this.messages.length - 8 ? Math.min(600, toolCap) : toolCap;
      return m.content.length > cap ? { ...m, content: m.content.slice(0, cap) + '\n…[truncated]' } : m;
    });

    let total = size(sys);
    let start = msgs.length - 1;
    total += msgs.length ? size(msgs[start]) : 0;
    while (start > 0 && total + size(msgs[start - 1]) <= budget) {
      start--;
      total += size(msgs[start]);
    }
    while (start > 0 && msgs[start].role === 'tool') start--; // keep tool results with their call
    const kept = msgs.slice(start);
    const out = [sys];
    if (kept.length && kept[0].role !== 'user') {
      out.push({ role: 'user', content: '(Earlier conversation was trimmed to fit free-tier limits. Continue from here.)' });
    }
    return out.concat(kept);
  }

  /** Run one user request through the tool loop. Returns when the model stops calling tools. */
  async run(userText, signal) {
    this.messages.push({ role: 'user', content: userText });
    let spin = null;
    let started = false;
    const ensureSpin = (label) => {
      if (!spin) spin = ui.spinner(label);
      else spin.set(label);
    };
    const stopSpin = () => {
      spin?.stop();
      spin = null;
    };

    const onText = (t) => {
      if (!started) {
        t = t.replace(/^\s+/, '');
        if (!t) return;
        stopSpin();
        process.stdout.write(`\n${ui.cyan('●')} `);
        started = true;
      }
      process.stdout.write(t.replace(/\n/g, '\n  '));
    };

    for (let step = 0; step < MAX_STEPS; step++) {
      started = false;
      ensureSpin('Thinking');
      let resp;
      try {
        resp = await this.router.chat({
          build: (level) => this.build(level),
          tools: this.tools.defs,
          signal,
          onText,
          onSlot: (slot) => ensureSpin(`Thinking · ${slot.provider.id}`),
          onWait: (secs) => ensureSpin(`Free quotas are recharging, resuming in ${secs}s`),
          onRestart: () => {
            if (started) process.stdout.write('\n');
            started = false;
          },
        });
      } catch (e) {
        stopSpin();
        this.dropDanglingUser();
        throw e;
      }
      stopSpin();
      if (started) process.stdout.write('\n');

      if (resp.exhausted) {
        const at = new Date(resp.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        console.log(`\n${ui.yellow('●')} All free quotas are used up for now. They recharge around ${ui.bold(at)}.`);
        console.log(ui.dim('  Add another free key with /keys (or run an Ollama model) and just ask again.'));
        this.dropDanglingUser();
        return;
      }

      if (this.config.showSwitch !== false && this.lastSlot && resp.slot.id !== this.lastSlot) {
        console.log(ui.dim(`  ↻ using ${resp.slot.provider.id} · ${resp.slot.model}`));
      }
      this.lastSlot = resp.slot.id;

      const msg = { role: 'assistant', content: resp.content || '' };
      if (resp.tool_calls.length) msg.tool_calls = resp.tool_calls;
      this.messages.push(msg);
      if (!resp.tool_calls.length) return;

      const pending = [...resp.tool_calls];
      try {
        while (pending.length) {
          const call = pending[0];
          let args = null;
          try {
            const a = call.function.arguments;
            args = typeof a === 'string' ? JSON.parse(a || '{}') : a;
          } catch {}
          const name = call.function.name;
          console.log(`\n${ui.cyan('●')} ${ui.bold(toolLabel(name))}${ui.dim('(' + describeCall(name, args || {}) + ')')}`);
          const result = args
            ? await this.tools.run(name, args)
            : { output: 'Error: tool arguments were not valid JSON. Call the tool again with valid JSON.', summary: 'invalid arguments', error: true };
          console.log(`  ${result.error ? ui.yellow('⎿') : ui.dim('⎿')}  ${ui.dim(result.summary)}`);
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: result.output });
          pending.shift();
          if (signal?.aborted) throw new AbortError();
        }
      } catch (e) {
        for (const c of pending) this.messages.push({ role: 'tool', tool_call_id: c.id, content: 'Interrupted by the user.' });
        throw e;
      }
    }
    console.log(`\n${ui.yellow('●')} Stopped after ${MAX_STEPS} steps. Say "continue" to keep going.`);
  }

  /** If a turn ends without any assistant answer, don't leave a lone user message that breaks role order. */
  dropDanglingUser() {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'user') this.messages.pop();
  }
}

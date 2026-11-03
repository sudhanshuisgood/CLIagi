// End-to-end tests against a local mock of an OpenAI-compatible API.
// No network, no real keys. Run with: npm test
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'localdost.js');
const hits = { rate: 0, auth: 0, good: 0, flaky: 0 };

const sse = (res, chunks) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
};
const textChunks = (t) => [{ choices: [{ delta: { content: t.slice(0, 5) } }] }, { choices: [{ delta: { content: t.slice(5) } }] }];
const toolChunks = (name, args) => {
  const s = JSON.stringify(args);
  return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x1', function: { name, arguments: s.slice(0, 10) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: s.slice(10) } }] } }] },
  ];
};

/** Scripted "model": write a file, edit it, then answer. Driven by how many tool results it has seen. */
function script(messages) {
  const n = messages.filter((m) => m.role === 'tool').length;
  if (n === 0) return toolChunks('write_file', { path: 'hello.txt', content: 'hello world\nline two\n' });
  if (n === 1) return toolChunks('edit_file', { path: 'hello.txt', old_string: 'line two', new_string: 'line 2' });
  return textChunks('All done: created and edited hello.txt');
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    const p = req.url;
    if (p.startsWith('/rate/')) {
      hits.rate++;
      res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '300' });
      return res.end(JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 5m0s.' } }));
    }
    if (p.startsWith('/auth/')) {
      hits.auth++;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid API Key' } }));
    }
    if (p.startsWith('/flaky/')) {
      hits.flaky++;
      if (hits.flaky === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '1' });
        return res.end(JSON.stringify({ error: { message: 'slow down' } }));
      }
      return sse(res, textChunks('recovered after waiting'));
    }
    hits.good++;
    return sse(res, script(j.messages || []));
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = (n) => `http://127.0.0.1:${port}/${n}/v1`;

function run(args, config, cwd) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dost-home-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return new Promise((resolve) => {
    const c = spawn('node', [bin, ...args], { cwd, env: { ...process.env, LOCALDOST_HOME: home, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => c.kill('SIGKILL'), 60000);
    c.on('close', (status) => {
      clearTimeout(t);
      resolve({ status, out });
    });
  });
}

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.error(`  ✖ ${name}\n${e.stack}`);
    server.close();
    process.exit(1);
  }
};

console.log('Local Dost tests');

await test('fails over silently past a rate-limited and a rejected provider, then runs the tool loop', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dost-proj-'));
  const r = await run(['-p', 'make hello.txt', '--yolo'], {
    order: ['a', 'b', 'c'],
    custom: [
      { id: 'a', base: base('rate'), key: 'k', models: ['m'] },
      { id: 'b', base: base('auth'), key: 'k', models: ['m'] },
      { id: 'c', base: base('good'), key: 'k', models: ['m'] },
    ],
  }, cwd);
  assert.equal(r.status, 0, r.out);
  assert.equal(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8'), 'hello world\nline 2\n');
  assert.match(r.out, /All done: created and edited hello\.txt/);
  assert.doesNotMatch(r.out, /429|401|rate limit|invalid api key|error/i, 'no provider errors may reach the screen');
});

await test('waits out a short rate limit instead of failing', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dost-proj-'));
  const r = await run(['-p', 'hi'], { custom: [{ id: 'f', base: base('flaky'), key: 'k', models: ['m'] }] }, cwd);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /recovered after waiting/);
  assert.doesNotMatch(r.out, /429|error/i);
});

await test('denies edits in non-interactive mode without --yolo', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dost-proj-'));
  await run(['-p', 'make hello.txt'], { custom: [{ id: 'c', base: base('good'), key: 'k', models: ['m'] }] }, cwd);
  assert.equal(fs.existsSync(path.join(cwd, 'hello.txt')), false);
});

await test('shows a friendly message (not an error) when no provider is configured', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dost-proj-'));
  const r = await run(['-p', 'hi'], {}, cwd);
  assert.match(r.out, /No AI provider is set up yet/);
});

await test('--version and --help work', async () => {
  const cwd = os.tmpdir();
  assert.match((await run(['--version'], {}, cwd)).out, /^\d+\.\d+\.\d+/);
  assert.match((await run(['--help'], {}, cwd)).out, /localdost setup/);
});

// ---- tool unit tests (no model involved) ----
const { createTools } = await import('../src/tools.js');
const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dost-tools-'));
const reviews = [];
const T = createTools({ cwd: tdir, signal: () => undefined, review: async (r) => (reviews.push(r), true) });

await test('edit_file: exact, unique replace; refuses ambiguous and missing matches', async () => {
  fs.writeFileSync(path.join(tdir, 'a.js'), 'const a = 1;\nconst b = 1;\n');
  assert.ok((await T.run('edit_file', { path: 'a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' })).output.startsWith('Edited'));
  assert.equal(fs.readFileSync(path.join(tdir, 'a.js'), 'utf8'), 'const a = 2;\nconst b = 1;\n');
  assert.match((await T.run('edit_file', { path: 'a.js', old_string: '= ', new_string: '=' })).output, /matches \d+ places/);
  assert.match((await T.run('edit_file', { path: 'a.js', old_string: 'nope', new_string: 'x' })).output, /not found/);
});

await test('edit_file: keeps CRLF files intact', async () => {
  fs.writeFileSync(path.join(tdir, 'w.txt'), 'one\r\ntwo\r\nthree\r\n');
  await T.run('edit_file', { path: 'w.txt', old_string: 'one\ntwo', new_string: '1\n2' });
  assert.equal(fs.readFileSync(path.join(tdir, 'w.txt'), 'utf8'), '1\r\n2\r\nthree\r\n');
});

await test('undo restores edited and removes created files', async () => {
  await T.run('write_file', { path: 'new.txt', content: 'x' });
  assert.match(T.undo(), /Removed new\.txt/);
  assert.equal(fs.existsSync(path.join(tdir, 'new.txt')), false);
  assert.match(T.undo(), /Restored w\.txt/);
});

await test('secrets files and outside-folder reads require explicit review', async () => {
  fs.writeFileSync(path.join(tdir, '.env'), 'SECRET=1');
  reviews.length = 0;
  await T.run('read_file', { path: '.env' });
  assert.equal(reviews.at(-1).force, true);
  fs.writeFileSync(path.join(tdir, '.env.example'), 'X=');
  reviews.length = 0;
  await T.run('read_file', { path: '.env.example' });
  assert.equal(reviews.length, 0);
});

await test('find_files and search_text work and skip node_modules', async () => {
  fs.mkdirSync(path.join(tdir, 'src/deep'), { recursive: true });
  fs.mkdirSync(path.join(tdir, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(tdir, 'src/deep/m.ts'), 'export const needle = 1;\n');
  fs.writeFileSync(path.join(tdir, 'node_modules/x/i.ts'), 'needle');
  assert.equal((await T.run('find_files', { pattern: '**/*.ts' })).output.trim(), 'src/deep/m.ts');
  assert.match((await T.run('search_text', { pattern: 'needle', include: '*.ts' })).output, /^src\/deep\/m\.ts:1:/);
});

await test('run_command: output, exit codes, and dangerous commands force a prompt', async () => {
  const ok = await T.run('run_command', { command: 'echo hi' });
  assert.match(ok.output, /exit code 0\nhi/);
  assert.match((await T.run('run_command', { command: 'exit 3' })).output, /exit code 3/);
  reviews.length = 0;
  await T.run('run_command', { command: 'echo rm -rf / # sudo test' });
  assert.equal(reviews.at(-1).danger, true);
});

server.close();
console.log(`\n${passed} passed`);

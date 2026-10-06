import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const stage = readFileSync(join(root, 'release/latest-stage.txt'), 'utf8').trim();
if (!stage.startsWith(join(root, 'release') + '\\')) throw new Error('Unexpected stage directory');
const directory = mkdtempSync(join(tmpdir(), 'mudu-packaged-test-'));
const port = 43991;
for (let iteration = 0; iteration < 2; iteration++) {
  const child = spawn(
    join(stage, 'runtime/node.exe'),
    [join(stage, 'apps/desktop/launch.mjs'), directory, String(port)],
    { cwd: stage, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exit = once(child, 'exit');
  let ready = false;
  let output = '';
  child.stderr.on('data', () => {});
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    ready = output.includes('MUDU_DESKTOP_READY');
  });
  try {
    const deadline = Date.now() + 30000;
    while (!ready && Date.now() < deadline && child.exitCode === null)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(ready, 'Packaged Host must become ready');
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(health.status, 200);
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
    assert.ok(existsSync(join(directory, 'mudu.sqlite')));
    child.stdin.write('shutdown\n');
    const result = await Promise.race([
      exit,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown timed out')), 20000).unref(),
      ),
    ]);
    assert.equal(result[0], 0);
    console.log(
      `PASS packaged Host ${iteration === 0 ? 'first startup' : 'restart'}: health, built frontend, isolated data, graceful shutdown`,
    );
  } finally {
    if (child.exitCode === null) {
      child.stdin.end();
      child.kill();
    }
  }
}

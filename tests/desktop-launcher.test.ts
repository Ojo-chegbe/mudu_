import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error JavaScript packaging module is also consumed by native launcher.
import { publicConfiguration, hostEnvironment } from '../apps/desktop/launch.mjs';

test(
  'native desktop policy keeps Host views and downloads private and blocks unsafe shell targets',
  { skip: process.platform !== 'win32' },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'mudu-desktop-policy-'));
    const executable = join(directory, 'policy.exe');
    t.after(() => {
      unlinkSync(executable);
      rmdirSync(directory);
    });
    const compiler = join(
      process.env.WINDIR ?? 'C:/Windows',
      'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
    );
    const compiled = spawnSync(
      compiler,
      [
        '/nologo',
        '/target:exe',
        '/out:' + executable,
        resolve('apps/desktop/DesktopPolicy.cs'),
        resolve('tests/desktop-policy.cs'),
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const checked = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout, /PASS desktop navigation/);
  },
);

test('desktop packaging never exports private server credentials', () => {
  const env = {
    MUDU_SUPABASE_URL: 'https://example.supabase.co',
    MUDU_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    MUDU_DATABASE_URL: 'secret',
    MUDU_GOOGLE_AI_KEY: 'secret',
  };
  assert.deepEqual(Object.keys(publicConfiguration(env)).sort(), [
    'MUDU_SUPABASE_PUBLISHABLE_KEY',
    'MUDU_SUPABASE_URL',
  ]);
});
test('desktop packaging rejects privileged Supabase keys and incomplete configuration', () => {
  assert.throws(() =>
    publicConfiguration({
      MUDU_SUPABASE_URL: 'https://example.supabase.co',
      MUDU_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_secret',
    }),
  );
  assert.throws(() => publicConfiguration({ MUDU_SUPABASE_URL: 'https://example.supabase.co' }));
  assert.deepEqual(publicConfiguration({}), {});
});
test('desktop runtime ignores inherited server and listener overrides', () => {
  const env = hostEnvironment(
    {
      PATH: 'runtime',
      MUDU_DATABASE_URL: 'secret',
      MUDU_BIND: '0.0.0.0',
      MUDU_WEB_ORIGIN: 'https://wrong',
    },
    {},
    './desktop-test-data',
    4319,
  );
  assert.equal(env.PATH, 'runtime');
  assert.equal(env.MUDU_DATABASE_URL, undefined);
  assert.equal(env.MUDU_WEB_ORIGIN, undefined);
  assert.equal(env.MUDU_BIND, '127.0.0.1');
  assert.equal(env.MUDU_ORIGIN, 'http://127.0.0.1:4319');
});

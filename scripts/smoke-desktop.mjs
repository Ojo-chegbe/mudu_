import { readFileSync, mkdtempSync, cpSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

if (process.platform !== 'win32') throw new Error('Run the desktop smoke test on Windows.');
const root = resolve(import.meta.dirname, '..');
const stage = process.argv[2]
  ? resolve(process.argv[2])
  : readFileSync(join(root, 'release/latest-stage.txt'), 'utf8').trim();
const build = join(root, '.packaging', 'desktop-smoke-' + Date.now());
mkdirSync(build, { recursive: true });
for (const name of [
  'Microsoft.Web.WebView2.Core.dll',
  'Microsoft.Web.WebView2.WinForms.dll',
  'WebView2Loader.dll',
])
  cpSync(join(stage, name), join(build, name));
const executable = join(build, 'DesktopSmoke.exe');
const compiler = join(
  process.env.WINDIR ?? 'C:/Windows',
  'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
);
const compiled = spawnSync(
  compiler,
  [
    '/nologo',
    '/target:exe',
    '/platform:x64',
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    '/r:' + join(build, 'Microsoft.Web.WebView2.Core.dll'),
    '/r:' + join(build, 'Microsoft.Web.WebView2.WinForms.dll'),
    '/main:DesktopSmoke',
    '/out:' + executable,
    ...[
      'apps/desktop/HostLauncher.cs',
      'apps/desktop/WorkspaceView.cs',
      'apps/desktop/DesktopPolicy.cs',
      'scripts/DesktopSmoke.cs',
    ].map((path) => join(root, path)),
  ],
  { stdio: 'inherit', windowsHide: true },
);
if (compiled.status !== 0) throw new Error('Desktop smoke compilation failed.');
const directory = mkdtempSync(join(tmpdir(), 'mudu-desktop-smoke-'));
const child = spawn(executable, [stage, directory, '43992'], {
  stdio: 'inherit',
  windowsHide: true,
});
const [code] = await once(child, 'exit');
console.log('Isolated desktop smoke data and screenshot: ' + directory);
if (code !== 0) throw new Error('Native desktop smoke test failed.');

import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { publicConfiguration } from '../apps/desktop/launch.mjs';
import { prepareDesktopDependencies } from './desktop-dependencies.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Build on Windows x64.');
const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const output = join(root, 'release');
const stage = join(output, `host-${version}-${Date.now()}`);
const cache = join(root, '.packaging');
mkdirSync(cache, { recursive: true });
mkdirSync(stage, { recursive: true });
function run(program, args, cwd = root) {
  const result = spawnSync(program, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('Packaging step failed: ' + program);
}
function powershell(command) {
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
}
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
// A reviewed runtime version, with official SHA-256 validation; never download "latest".
const runtimeVersion = '24.13.0';
const archiveName = `node-v${runtimeVersion}-win-x64.zip`;
const base = `https://nodejs.org/dist/v${runtimeVersion}/`;
const sums = await (
  await fetch(base + 'SHASUMS256.txt', { signal: AbortSignal.timeout(60000) })
).text();
const expected = sums
  .split('\n')
  .find((line) => line.endsWith('  ' + archiveName))
  ?.split(' ')[0];
if (!expected || !/^[a-f0-9]{64}$/.test(expected))
  throw new Error('Official runtime checksum unavailable.');
const archive = join(cache, archiveName);
if (!existsSync(archive)) {
  const response = await fetch(base + archiveName, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Runtime download failed.');
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}
if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== expected)
  throw new Error('Runtime checksum mismatch. Do not use this download.');
const runtimeRoot = join(cache, 'runtime-' + runtimeVersion);
if (!existsSync(join(runtimeRoot, `node-v${runtimeVersion}-win-x64`, 'node.exe')))
  powershell(
    `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(runtimeRoot)} -Force`,
  );
powershell('npm.cmd run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
for (const folder of ['apps/host', 'apps/desktop', 'packages', 'dist'])
  cpSync(join(root, folder), join(stage, folder), { recursive: true });
cpSync(join(root, 'package.json'), join(stage, 'package.json'));
cpSync(join(root, 'package-lock.json'), join(stage, 'package-lock.json'));
for (const document of [
  'HOST-INSTALLATION.md',
  'ACCOUNT-WORKSPACE.md',
  'ACCOUNT-SETTINGS.md',
  'PASSWORD-RECOVERY.md',
])
  cpSync(join(root, 'docs', document), join(stage, document));
// Install only production dependencies in a new staging directory; never ship the working .env.
powershell(
  `Set-Location -LiteralPath ${quote(stage)}; npm.cmd ci --omit=dev --ignore-scripts; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
);
mkdirSync(join(stage, 'runtime'));
const extracted = join(runtimeRoot, `node-v${runtimeVersion}-win-x64`);
cpSync(join(extracted, 'node.exe'), join(stage, 'runtime/node.exe'));
cpSync(join(extracted, 'LICENSE'), join(stage, 'runtime/LICENSE'));
const env = existsSync(join(root, '.env'))
  ? parseEnv(readFileSync(join(root, '.env'), 'utf8'))
  : {};
writeFileSync(join(stage, 'host-public.json'), JSON.stringify(publicConfiguration(env), null, 2));
const desktop = await prepareDesktopDependencies(cache, stage);
const compiler = join(
  process.env.WINDIR ?? 'C:/Windows',
  'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
);
run(compiler, [
  '/nologo',
  '/target:winexe',
  '/platform:x64',
  '/optimize+',
  '/r:System.Windows.Forms.dll',
  '/r:System.Drawing.dll',
  ...desktop.assemblies.map((path) => '/r:' + path),
  '/win32manifest:' + join(root, 'apps/desktop/HostLauncher.manifest'),
  '/out:' + join(stage, 'MUDU Host.exe'),
  join(root, 'apps/desktop/HostLauncher.cs'),
  join(root, 'apps/desktop/WorkspaceView.cs'),
  join(root, 'apps/desktop/DesktopPolicy.cs'),
]);
writeFileSync(join(output, 'latest-stage.txt'), stage);
console.log('Portable Host built: ' + stage);
const installerCompiler =
  process.env.MUDU_MAKENSIS ?? join(root, '.packaging/nsis/nsis-3.13/makensis.exe');
if (existsSync(installerCompiler)) {
  mkdirSync(join(output, 'installers'), { recursive: true });
  run(installerCompiler, [
    '/DSTAGE=' + stage,
    '/DVERSION=' + version,
    join(root, 'apps/desktop/installer.nsi'),
  ]);
  console.log('Installer built in release/installers.');
} else {
  console.log(
    'Installer compiler not installed. Set MUDU_MAKENSIS to makensis.exe and run again to produce Setup.exe.',
  );
}

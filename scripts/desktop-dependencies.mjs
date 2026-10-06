import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, renameSync, cpSync, writeFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

export const webViewSdkVersion = '1.0.3856.49';
// Pinned official NuGet package. This value is checked before extraction or compilation.
export const webViewSdkSha256 = 'bc0f76eb911b569838dc4aa8f8d325269b966bedb592863d26211aef3a099f1a';
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
function powershell(command) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; ' + command],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || 'Desktop dependency verification failed.');
  return result.stdout.trim();
}
async function download(url, path, timeoutMs) {
  if (existsSync(path)) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) throw new Error('Desktop dependency download failed.');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path + '.download'));
  renameSync(path + '.download', path);
}
const checksum = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export async function prepareDesktopDependencies(cache, stage) {
  mkdirSync(cache, { recursive: true });
  const sdkArchive = join(cache, `Microsoft.Web.WebView2.${webViewSdkVersion}.zip`);
  await download(
    `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${webViewSdkVersion}/microsoft.web.webview2.${webViewSdkVersion}.nupkg`,
    sdkArchive,
    600000,
  );
  if (checksum(sdkArchive) !== webViewSdkSha256)
    throw new Error('WebView2 SDK checksum mismatch. Do not use this package.');
  const sdk = join(cache, 'webview2-' + webViewSdkVersion);
  powershell(
    `Expand-Archive -LiteralPath ${quote(sdkArchive)} -DestinationPath ${quote(sdk)} -Force`,
  );
  const assemblies = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll'];
  for (const name of assemblies) cpSync(join(sdk, 'lib/net462', name), join(stage, name));
  cpSync(
    join(sdk, 'runtimes/win-x64/native/WebView2Loader.dll'),
    join(stage, 'WebView2Loader.dll'),
  );
  mkdirSync(join(stage, 'licenses'), { recursive: true });
  cpSync(join(sdk, 'LICENSE.txt'), join(stage, 'licenses/WebView2-LICENSE.txt'));
  cpSync(join(sdk, 'NOTICE.txt'), join(stage, 'licenses/WebView2-NOTICE.txt'));
  const installer =
    process.env.MUDU_WEBVIEW2_INSTALLER ||
    join(cache, 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe');
  await download('https://go.microsoft.com/fwlink/?linkid=2124701', installer, 600000);
  // The Evergreen installer changes over time; validate Microsoft's signature on every build.
  const runtimeVersion = powershell(
    `$signature = Get-AuthenticodeSignature -LiteralPath ${quote(installer)}; if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation(?:,|$)') { throw 'WebView2 installer must have a valid Microsoft signature.' }; (Get-Item -LiteralPath ${quote(installer)}).VersionInfo.FileVersion`,
  );
  mkdirSync(join(stage, 'prerequisites'), { recursive: true });
  cpSync(installer, join(stage, 'prerequisites/WebView2RuntimeInstaller.exe'));
  writeFileSync(
    join(stage, 'desktop-dependencies.json'),
    JSON.stringify(
      {
        webViewSdkVersion,
        sdkSha256: webViewSdkSha256,
        runtimeInstallerVersion: runtimeVersion,
        runtimeInstallerSha256: checksum(installer),
      },
      null,
      2,
    ),
  );
  return { assemblies: assemblies.map((name) => join(stage, name)) };
}

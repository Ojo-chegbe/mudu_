import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.ts';
import { createHandler } from './http.ts';
import { ExamStore } from './store.ts';
import { LocalDelivery } from './local-delivery.ts';
import { SupabaseAuth, supabaseConfig, authSessionKey } from './supabase-auth.ts';
import { SupabaseRecords } from './cloud-records.ts';
import type { CloudSync } from './cloud-sync.ts';
import { SupabaseBankStorage } from './cloud-bank-storage.ts';
import type { CloudQuestionBank } from './cloud-question-bank.ts';
import { SupabaseRosterStorage } from './cloud-roster-storage.ts';
import type { CloudRosters } from './cloud-rosters.ts';
import { SupabaseAuthoringStorage } from './cloud-authoring-storage.ts';
import { SupabasePreparationStorage } from './local-preparation-storage.ts';
import type { LocalPreparation } from './local-preparation.ts';
import { onlineDatabase } from './online-postgres.ts';
import { OnlineExecution } from './online-execution.ts';

const bind = process.env.MUDU_BIND ?? '127.0.0.1';
const port = Number(process.env.MUDU_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('MUDU_PORT must be a valid port.');
const certPath = process.env.MUDU_TLS_CERT;
const keyPath = process.env.MUDU_TLS_KEY;
if (Boolean(certPath) !== Boolean(keyPath))
  throw new Error('Provide both MUDU_TLS_CERT and MUDU_TLS_KEY.');
const secure = Boolean(certPath && keyPath);
if (!['127.0.0.1', '::1', 'localhost'].includes(bind) && !secure)
  throw new Error('LAN access requires HTTPS. Configure a trusted certificate and key first.');
const origin =
  process.env.MUDU_ORIGIN ??
  `${secure ? 'https' : 'http'}://${bind === '::1' ? '[::1]' : bind}:${port}`;
const originUrl = new URL(origin);
if (originUrl.origin !== origin || originUrl.protocol !== (secure ? 'https:' : 'http:'))
  throw new Error('MUDU_ORIGIN must be the exact public origin with the correct protocol.');
const dataDir =
  process.env.MUDU_DATA_DIR ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'MUDU', 'Host');
const resolvedData = resolve(dataDir);
const oneDriveRoots = [
  process.env.OneDrive,
  process.env.OneDriveConsumer,
  process.env.OneDriveCommercial,
].filter(Boolean) as string[];
if (
  oneDriveRoots.some(
    (root) =>
      resolvedData.toLowerCase() === resolve(root).toLowerCase() ||
      resolvedData.toLowerCase().startsWith(resolve(root).toLowerCase() + '\\'),
  )
) {
  throw new Error(
    'Place Host data outside OneDrive. Use MUDU_DATA_DIR to choose a local application data directory.',
  );
}
mkdirSync(resolvedData, { recursive: true, mode: 0o700 });
const db = openDatabase(join(resolvedData, 'mudu.sqlite'));
const cloudConfig = supabaseConfig(process.env);
const onlinePool = onlineDatabase(process.env);
if (onlinePool && !cloudConfig)
  throw new Error('Online delivery requires cloud authentication configuration.');
const hostKey = authSessionKey(resolvedData);
const cloudAuth = cloudConfig
  ? { provider: new SupabaseAuth(cloudConfig), sessionKey: hostKey }
  : undefined;
const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
const identityMode = process.env.MUDU_IDENTITY_MODE ?? 'primary';
if (!['primary', 'replica'].includes(identityMode))
  throw new Error('MUDU_IDENTITY_MODE must be primary or replica.');
const localDelivery = new LocalDelivery(resolvedData, (candidateOrigin) =>
  createHandler(db, {
    identityMode: identityMode as 'primary' | 'replica',
    origin: candidateOrigin,
    secure: false,
    staticDir: existsSync(dist) ? dist : undefined,
    localDelivery,
    candidateListener: true,
  }),
);
let cloudSync: CloudSync | undefined;
let localPreparation: LocalPreparation | undefined;
let cloudBank: CloudQuestionBank | undefined;
let cloudRosters: CloudRosters | undefined;
let cloudAuthoring: import('./cloud-authoring.ts').CloudAuthoring | undefined;
const handler = await createHandler(db, {
  online: onlinePool ? new OnlineExecution(onlinePool) : undefined,
  preparationKey: hostKey,
  cloudPreparation: cloudConfig ? new SupabasePreparationStorage(cloudConfig) : undefined,
  onLocalPreparation: (preparation) => {
    localPreparation = preparation;
  },
  cloudAuthoring: cloudConfig ? new SupabaseAuthoringStorage(cloudConfig) : undefined,
  onCloudAuthoring: (authoring) => {
    cloudAuthoring = authoring;
  },
  cloudRosters: cloudConfig ? new SupabaseRosterStorage(cloudConfig) : undefined,
  onCloudRosters: (rosters) => {
    cloudRosters = rosters;
  },
  cloudBank: cloudConfig ? new SupabaseBankStorage(cloudConfig) : undefined,
  onCloudBank: (bank) => {
    cloudBank = bank;
  },
  cloudRecords: cloudConfig ? new SupabaseRecords(cloudConfig) : undefined,
  onCloudSync: (sync) => {
    cloudSync = sync;
  },
  cloudAuth,
  localDelivery,
  identityMode: identityMode as 'primary' | 'replica',
  origin,
  secure,
  webOrigin: process.env.MUDU_WEB_ORIGIN,
  staticDir: existsSync(dist) ? dist : undefined,
});
const server = secure
  ? createHttpsServer({ cert: readFileSync(certPath!), key: readFileSync(keyPath!) }, handler)
  : createHttpServer(handler);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.maxHeadersCount = 50;
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
  void stop();
});
server.listen(port, bind, () => {
  console.log(`MUDU Host: ${origin}`);
  if (process.env.MUDU_DESKTOP === '1') console.log('MUDU_DESKTOP_READY');
  console.log(`Local data: ${resolvedData}`);
  if (!secure)
    console.log('Open Local delivery in the workspace to connect candidates through your router.');
});
const store = new ExamStore(db);
const reconciler = setInterval(() => {
  try {
    store.reconcile();
    void cloudSync?.pump();
    cloudBank?.pump();
    cloudRosters?.pump();
    cloudAuthoring?.pump();
    void localPreparation?.pump();
  } catch (error) {
    console.error(
      'Deadline reconciliation failed:',
      error instanceof Error ? error.name : 'Unknown error',
    );
  }
}, 1000);
reconciler.unref();
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  if (process.env.MUDU_DESKTOP === '1') process.stdin.destroy();
  clearInterval(reconciler);
  await cloudSync?.stop();
  await cloudBank?.stop();
  await cloudRosters?.stop();
  await cloudAuthoring?.stop();
  await localPreparation?.stop();
  await localDelivery.close();
  server.close(() => {
    db.close();
    void onlinePool?.end();
  });
  server.closeIdleConnections();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (process.env.MUDU_DESKTOP === '1') {
  process.stdin.setEncoding('utf8');
  let desktopInput = '';
  process.stdin.on('data', (chunk: string) => {
    desktopInput += chunk;
    if (desktopInput.length > 1024) desktopInput = '';
    if (desktopInput.split(/\r?\n/).includes('shutdown')) void stop();
  });
  // A terminated launcher must not leave an invisible server behind.
  process.stdin.on('end', () => void stop());
}
await localDelivery.restore();

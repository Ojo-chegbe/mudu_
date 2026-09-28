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
const handler = await createHandler(db, {
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
  console.log(`Local data: ${resolvedData}`);
  if (!secure)
    console.log('Open Local delivery in the workspace to connect candidates through your router.');
});
const store = new ExamStore(db);
const reconciler = setInterval(() => {
  try {
    store.reconcile();
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
  clearInterval(reconciler);
  await localDelivery.close();
  server.close(() => {
    db.close();
  });
  server.closeIdleConnections();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await localDelivery.restore();

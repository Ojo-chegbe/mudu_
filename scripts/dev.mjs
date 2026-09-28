import { spawn } from 'node:child_process';

const processes = [
  spawn(process.execPath, ['--env-file-if-exists=.env', '--watch', 'apps/host/main.ts'], {
    stdio: 'inherit',
    env: { ...process.env, MUDU_WEB_ORIGIN: 'http://127.0.0.1:5173' },
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
    stdio: 'inherit',
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill();
  process.exitCode = code;
}
for (const child of processes) {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code) => stop(code ?? 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

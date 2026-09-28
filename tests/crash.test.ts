import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';

test(
  'acknowledged answers survive abrupt Host process termination',
  { timeout: 15000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mudu-crash-'));
    const path = join(directory, 'exam.sqlite');
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./crash-worker.ts', import.meta.url)), path],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const exited = once(child, 'exit');
    try {
      const message = await new Promise<string>((resolve, reject) => {
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (output.includes('\n')) resolve(output.split('\n')[0]);
        });
        child.once('error', reject);
        child.once('exit', () => {
          if (!output.includes('\n'))
            reject(new Error('Host exited before acknowledging its answer.'));
        });
      });
      const receipt = JSON.parse(message);
      child.kill('SIGKILL');
      await exited;
      const db = openDatabase(path);
      try {
        const store = new ExamStore(db);
        assert.deepEqual(
          store.responses(receipt.attemptId)[receipt.questionId].value,
          receipt.answer,
        );
        assert.equal(
          store.findAttempt(receipt.sittingId, 'crash-candidate')?.id,
          receipt.attemptId,
        );
        assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      } finally {
        db.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
      rmdirSync(directory);
    }
  },
);

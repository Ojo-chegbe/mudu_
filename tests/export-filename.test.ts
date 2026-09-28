import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultsDisposition } from '../apps/host/export-filename.ts';

test('result download names preserve exam titles and safely encode Unicode', () => {
  assert.match(resultsDisposition('PCH 401 Final'), /filename="PCH 401 Final - results.csv"/);
  assert.ok(
    resultsDisposition('Évaluation').includes(encodeURIComponent('Évaluation - results.csv')),
  );
  assert.doesNotMatch(resultsDisposition('Exam\r\n"/\\:*?<>|'), /[\r\n]/);
  assert.match(resultsDisposition('  '), /Assessment - results.csv/);
});

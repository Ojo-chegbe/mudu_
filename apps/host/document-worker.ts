import { parentPort, workerData } from 'node:worker_threads';
import { extractDocument } from './document-extraction.ts';

try {
  parentPort!.postMessage({ result: await extractDocument(workerData.name, workerData.bytes) });
} catch (error) {
  parentPort!.postMessage({
    error:
      error instanceof Error
        ? error.message.slice(0, 400)
        : 'This document could not be read. Try exporting a new copy.',
  });
}

import { Worker } from 'node:worker_threads';
import type { IncomingMessage } from 'node:http';
import { DomainError } from '../../packages/exam-core/model.ts';
import { documentExtensions, maxDocumentBytes } from '../../packages/contracts/documents.ts';
import type { ExtractedDocument } from '../../packages/contracts/documents.ts';

let active = 0;
export function readDocumentInWorker(name: string, bytes: Uint8Array): Promise<ExtractedDocument> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./document-worker.ts', import.meta.url), {
      workerData: { name, bytes },
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 },
      stdout: true,
      stderr: true,
    });
    // Parser diagnostics may contain document fragments; do not send them to application logs.
    worker.stdout.resume();
    worker.stderr.resume();
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(
        new DomainError(
          'This document took too long to read. Upload a smaller file or paste the relevant text.',
          422,
        ),
      );
    }, 25000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      void worker.terminate();
      if (message.error) reject(new DomainError(message.error, 422));
      else resolve(message.result);
    });
    worker.once('error', () => {
      clearTimeout(timer);
      reject(
        new DomainError(
          'This document could not be processed safely. Upload a smaller file or a new copy.',
          422,
        ),
      );
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      reject(new DomainError('Document reading was interrupted. Please try a smaller file.', 422));
    });
  });
}
export async function uploadDocument(request: IncomingMessage, name: string) {
  if (request.headers['content-type'] !== 'application/octet-stream')
    throw new DomainError('Upload the document as a file.', 415);
  if (!name || name.length > 200 || /[\x00-\x1f/\\]/.test(name))
    throw new DomainError('Use a document with a simple filename of at most 200 characters.');
  if (
    !(documentExtensions as readonly string[]).includes(name.split('.').pop()?.toLowerCase() ?? '')
  )
    throw new DomainError(
      'Use PDF, DOCX, PPTX, ODT, TXT or Markdown. Save older Word or PowerPoint files as DOCX or PPTX first.',
      415,
    );
  if (Number(request.headers['content-length']) > maxDocumentBytes)
    throw new DomainError('Documents must be no larger than 10 MB.', 413);
  if (active >= 2)
    throw new DomainError('Other documents are being read. Please try again shortly.', 429);
  active++;
  const timer = setTimeout(() => request.destroy(), 15000);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxDocumentBytes)
        throw new DomainError('Documents must be no larger than 10 MB.', 413);
      chunks.push(Buffer.from(chunk));
    }
    clearTimeout(timer);
    if (!size) throw new DomainError('This file is empty. Choose another document.');
    return await readDocumentInWorker(name, Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
    active--;
  }
}

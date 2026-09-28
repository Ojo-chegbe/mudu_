export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
let csrf = '';
export function setCsrf(value: string | null) {
  csrf = value ?? '';
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; keepalive?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    keepalive: options.keepalive,
    cache: 'no-store',
    headers: {
      ...(options.method ? { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      value.message ?? 'The request could not be completed.',
      response.status,
      value.code,
    );
  return value as T;
}
export function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return 'Could not reach MUDU. Check your connection and try again.';
}
export async function extractDocumentFile(file: File, signal: AbortSignal) {
  const response = await fetch(
    `/api/question-bank/documents/extract?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf },
      body: file,
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(result.message ?? 'This document could not be read.', response.status);
  return result as import('../../packages/contracts/documents.ts').ExtractedDocument;
}
export function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

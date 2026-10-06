import type { CloudSyncStatus } from '../../packages/contracts/cloud-sync.ts';

export function selectableExams(status: Pick<CloudSyncStatus, 'ready' | 'items'>): string[] {
  const latest = new Map<string, string>();
  for (const item of status.items)
    if (!latest.has(item.assessmentId)) latest.set(item.assessmentId, item.state);
  return status.ready
    .filter((exam) => !latest.has(exam.id) || latest.get(exam.id) === 'synced')
    .map((exam) => exam.id);
}

// Keep the server's bounded request size without limiting how many rows can be selected.
// Acknowledge each batch only after it has been durably queued by the Host.
export async function queueSelectedExams(
  ids: readonly string[],
  send: (batch: string[]) => Promise<unknown>,
  acknowledge: (batch: string[]) => void,
) {
  const unique = [...new Set(ids)];
  for (let offset = 0; offset < unique.length; offset += 20) {
    const batch = unique.slice(offset, offset + 20);
    await send(batch);
    acknowledge(batch);
  }
}

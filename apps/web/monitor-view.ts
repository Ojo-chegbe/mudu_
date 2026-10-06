import type { MonitoredCandidate, MonitorStatus } from '../../packages/contracts/monitoring.ts';

export const monitorLabels: Record<MonitorStatus, string> = {
  waiting: 'Waiting',
  active: 'Active',
  disconnected: 'Disconnected',
  submitted: 'Submitted',
  expired: 'Time expired',
};
const priority: Record<MonitorStatus, number> = {
  disconnected: 0,
  waiting: 1,
  active: 2,
  submitted: 3,
  expired: 4,
};
export function monitorCandidates(
  candidates: MonitoredCandidate[],
  filter: MonitorStatus | 'all',
  query: string,
) {
  const search = query.trim().toLocaleLowerCase();
  return candidates
    .filter(
      (candidate) =>
        (filter === 'all' || candidate.status === filter) &&
        `${candidate.name} ${candidate.identifier}`.toLocaleLowerCase().includes(search),
    )
    .sort(
      (a, b) =>
        priority[a.status] - priority[b.status] ||
        a.identifier.localeCompare(b.identifier, undefined, { numeric: true }) ||
        a.id.localeCompare(b.id),
    );
}
export function contactAge(timestamp: number | null, now: number) {
  if (timestamp === null) return 'No contact yet';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

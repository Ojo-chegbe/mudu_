export function scheduleParts(timestamp: number | null | undefined) {
  if (!timestamp || !Number.isFinite(timestamp)) return { date: '', time: '' };
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return { date: '', time: '' };
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

export function scheduleTimestamp(date: string, time: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const timestamp = new Date(`${date}T${time}`).getTime();
  const parts = scheduleParts(timestamp);
  // Reject impossible dates and times, including a skipped daylight-saving hour.
  return parts.date === date && parts.time === time ? timestamp : null;
}

export function scheduleDay(offset: number, now = Date.now()) {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return scheduleParts(date.getTime()).date;
}

export function scheduleLabel(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

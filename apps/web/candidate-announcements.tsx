import { useState } from 'react';
import type { ExamAnnouncement } from '../../packages/contracts/exam-controls.ts';
import { api, errorMessage } from './api.ts';
import { Notice } from './ui.tsx';

export function CandidateAnnouncements({
  items,
  examApi,
}: {
  items: ExamAnnouncement[];
  examApi: string;
}) {
  const [read, setRead] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const unread = items.filter((a) => !a.read && !read.has(a.id));
  async function acknowledge(id: string) {
    if (busy) return;
    setBusy(id);
    setError('');
    try {
      await api(`${examApi}/announcements/read`, { method: 'POST', body: { id } });
      setRead((previous) => new Set([...previous, id]));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  if (!items.length) return null;
  return (
    <section className="candidate-announcements" aria-label="Examination announcements">
      {error && <Notice>{error}</Notice>}
      {unread.length > 0 && (
        <div className="candidate-announcement-unread" role="status" aria-live="polite">
          <strong>Announcement{unread.length > 1 ? 's' : ''} from your administrator</strong>
          {unread.map((a) => (
            <div key={a.id} className="candidate-announcement-item">
              <p className="pre-wrap">{a.message}</p>
              <div className="inline between">
                <time>
                  {new Date(a.createdAt).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </time>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy !== null}
                  onClick={() => void acknowledge(a.id)}
                >
                  {busy === a.id ? 'Saving…' : 'Got it'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <details className="control-announcement-history">
        <summary>All announcements ({items.length})</summary>
        <ul>
          {items.map((a) => (
            <li key={a.id}>
              <p className="pre-wrap">{a.message}</p>
              <time>{new Date(a.createdAt).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

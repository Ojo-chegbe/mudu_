import { useEffect, useId, useRef, useState } from 'react';
import type { NotificationFeed } from '../../packages/contracts/notifications.ts';
import { api, errorMessage } from './api.ts';
import { Icon, Notice } from './ui.tsx';

export function Notifications() {
  const [feed, setFeed] = useState<NotificationFeed | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  async function refresh() {
    try {
      setFeed(await api<NotificationFeed>('/notifications'));
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    let active = true;
    async function poll() {
      if (document.hidden) return;
      try {
        const value = await api<NotificationFeed>('/notifications');
        if (active) {
          setFeed(value);
          setError('');
        }
      } catch (e) {
        if (active) setError(errorMessage(e));
      }
    }
    void poll();
    const timer = setInterval(poll, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function markRead(ids: string[]) {
    setBusy(true);
    try {
      await api('/notifications', { method: 'POST', body: { ids }, keepalive: true });
      await refresh();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const items = feed?.items.filter((n) => !unreadOnly || n.readAt === null) ?? [];
  const unread = feed?.unread ?? 0;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="notification-trigger"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}${error ? ', unavailable' : ''}`}
        aria-haspopup="dialog"
        onClick={() => {
          dialog.current?.showModal();
          void refresh();
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
        {unread > 0 && (
          <span className="notification-count" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
        {error && !unread && <span aria-hidden="true">!</span>}
      </button>
      <dialog
        ref={dialog}
        className="notification-panel"
        aria-labelledby={titleId}
        onClose={() => trigger.current?.focus()}
      >
        <div className="notification-panel-heading">
          <div>
            <h2 id={titleId}>Notifications</h2>
            <p className="muted small">{feed ? `${unread} unread` : 'Checking for updates…'}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close notifications"
            onClick={() => dialog.current?.close()}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="notification-toolbar">
          <div className="actions">
            <button
              type="button"
              className="text-button"
              aria-pressed={!unreadOnly}
              onClick={() => setUnreadOnly(false)}
            >
              All
            </button>
            <button
              type="button"
              className="text-button"
              aria-pressed={unreadOnly}
              onClick={() => setUnreadOnly(true)}
            >
              Unread
            </button>
          </div>
          <button
            className="text-button"
            disabled={busy || !feed?.items.some((n) => n.readAt === null)}
            onClick={() =>
              void markRead(feed!.items.filter((n) => n.readAt === null).map((n) => n.id))
            }
          >
            {busy ? 'Saving…' : 'Mark shown as read'}
          </button>
        </div>
        {error && (
          <div className="notification-feedback">
            <Notice>{error}</Notice>
            <button className="text-button" onClick={refresh}>
              Try again
            </button>
          </div>
        )}
        {!feed && !error && (
          <p className="notification-empty" role="status">
            Loading notifications…
          </p>
        )}
        {feed && !items.length && (
          <div className="notification-empty">
            <strong>{unreadOnly ? 'You’re all caught up' : 'No notifications yet'}</strong>
            <p className="muted small">
              {unreadOnly
                ? 'There are no unread updates in this list.'
                : 'Registration and marking updates will appear here.'}
            </p>
          </div>
        )}
        <ul className="notification-list">
          {items.map((n) => (
            <li key={n.id} className={n.readAt === null ? 'unread' : ''}>
              <a
                href={n.href}
                onClick={async (event) => {
                  if (n.readAt !== null) return;
                  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
                    void markRead([n.id]);
                    return;
                  }
                  event.preventDefault();
                  if (busy) return;
                  if (await markRead([n.id])) location.assign(n.href);
                }}
                onAuxClick={(event) => {
                  if (event.button === 1 && n.readAt === null) void markRead([n.id]);
                }}
              >
                <strong>
                  {n.title}
                  {n.readAt === null && (
                    <span className="notification-unread-dot" aria-label="Unread" />
                  )}
                </strong>
                <p>{n.message}</p>
                <time dateTime={new Date(n.createdAt).toISOString()}>
                  {new Date(n.createdAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </time>
              </a>
              {n.readAt === null && (
                <button
                  className="text-button"
                  disabled={busy}
                  aria-label={`Mark ${n.title} as read`}
                  onClick={() => void markRead([n.id])}
                >
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>
        {feed && feed.items.length === 100 && (
          <p className="notification-feedback muted small">
            Showing up to 100 updates, unread first.
          </p>
        )}
      </dialog>
    </>
  );
}

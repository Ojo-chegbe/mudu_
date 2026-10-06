type ConnectionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (owner: string) => `mudu:cloud-connection:${owner}`;

// Remember only the confirmation step, never either password or a provider token.
export function pendingConnection(storage: ConnectionStorage, owner: string): string {
  try {
    if (!owner) return '';
    const value = JSON.parse(storage.getItem(key(owner)) ?? 'null');
    return value?.version === 1 &&
      typeof value.email === 'string' &&
      value.email.length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)
      ? value.email
      : '';
  } catch {
    return '';
  }
}

export function rememberConnection(storage: ConnectionStorage, owner: string, email: string) {
  try {
    if (!owner) return;
    if (email) storage.setItem(key(owner), JSON.stringify({ version: 1, email }));
    else storage.removeItem(key(owner));
  } catch {
    /* Storage restrictions must not block account connection. */
  }
}

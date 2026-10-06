import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { DomainError } from '../../packages/exam-core/model.ts';

export interface OnlineClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
  release(): void;
}
export interface OnlineDatabase {
  connect(): Promise<OnlineClient>;
  end(): Promise<void>;
}

/** Credentials never leave the server. Remote connections require verified TLS. */
export function onlineDatabase(env: NodeJS.ProcessEnv): OnlineDatabase | null {
  if (!env.MUDU_DATABASE_URL) return null;
  let url: URL;
  try {
    url = new URL(env.MUDU_DATABASE_URL);
  } catch {
    throw new Error('MUDU_DATABASE_URL must be a PostgreSQL connection address.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password)
    throw new Error('Configure the server-only PostgreSQL connection credentials.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // pg URL SSL options must not override certificate verification.
  url.search = '';
  const pool = new Pool({
    connectionString: url.toString(),
    ssl: local
      ? false
      : {
          rejectUnauthorized: true,
          ...(env.MUDU_DATABASE_CA ? { ca: readFileSync(env.MUDU_DATABASE_CA, 'utf8') } : {}),
        },
    max: 8,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', () => console.error('Online examination database connection interrupted.'));
  return pool;
}

export async function onlineTransaction<T>(
  database: OnlineDatabase,
  actor: string,
  examId: string,
  work: (client: OnlineClient) => Promise<T>,
): Promise<T> {
  let client: OnlineClient | undefined;
  try {
    client = await database.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE mudu_execution');
    await client.query('SET LOCAL search_path=pg_catalog,public');
    await client.query(
      "SELECT set_config('request.jwt.claim.sub',$1,true),set_config('mudu.exam_id',$2,true)",
      [actor, examId],
    );
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SET LOCAL lock_timeout='8s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error instanceof DomainError) throw error;
    const code = (error as { code?: string })?.code;
    if (code === 'M0004')
      throw new DomainError(
        'The source assessment changed. Refresh before publishing online.',
        409,
        'AUTHORING_CONFLICT',
      );
    if (['23505', '40001', '40P01', '55P03'].includes(code ?? ''))
      throw new DomainError(
        'Another request is being processed. Please try again.',
        409,
        'ONLINE_CONFLICT',
      );
    if (['42P01', '42704', '42501'].includes(code ?? ''))
      throw new DomainError(
        'Online examinations need database setup. Contact the administrator.',
        503,
        'ONLINE_SETUP_REQUIRED',
      );
    const unavailable = new DomainError(
      'The online examination service is temporarily unavailable. Please reconnect and try again.',
      503,
      'ONLINE_UNAVAILABLE',
    );
    unavailable.cause = error;
    throw unavailable;
  } finally {
    client?.release();
  }
}

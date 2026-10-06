import { onlineDatabase, onlineTransaction } from '../apps/host/online-postgres.ts';
import { DomainError } from '../packages/exam-core/model.ts';

const database = onlineDatabase(process.env);
if (!database) {
  console.error(
    'Set MUDU_DATABASE_URL in the server .env to enable online examinations. Use the PostgreSQL connection URI, not an API key.',
  );
  process.exitCode = 1;
} else {
  try {
    await onlineTransaction(
      database,
      '00000000-0000-0000-0000-000000000000',
      '',
      async (client) => {
        const tables = [
          'mudu_online_exams',
          'mudu_online_members',
          'mudu_online_rows',
          'mudu_online_events',
        ];
        for (const table of tables) {
          const row = (
            await client.query(
              "SELECT c.relrowsecurity AS protected,has_table_privilege('authenticated',c.oid,'SELECT') AS browser_read FROM pg_class c WHERE c.oid=to_regclass($1)",
              ['public.' + table],
            )
          ).rows[0];
          if (!row?.protected || row.browser_read)
            throw new DomainError(
              'Online examination tables are missing or their access policies are incomplete.',
            );
        }
        const role = (
          await client.query('SELECT rolname,rolcanlogin FROM pg_roles WHERE rolname=current_user')
        ).rows[0];
        if (role?.rolname !== 'mudu_execution' || role.rolcanlogin)
          throw new DomainError(
            'The server-only examination role is not configured correctly.',
            503,
            'ONLINE_SETUP_REQUIRED',
          );
        for (const name of [
          'mudu_online_source(uuid,bigint,text)',
          'mudu_online_admit(uuid)',
          'mudu_online_discover()',
        ]) {
          const row = (
            await client.query('SELECT to_regprocedure($1) AS routine', ['public.' + name])
          ).rows[0];
          if (!row.routine)
            throw new DomainError(
              'The online examination migration is incomplete.',
              503,
              'ONLINE_SETUP_REQUIRED',
            );
        }
      },
    );
    console.log(
      'Online database schema and server role are ready. This is a setup check, not a load test.',
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Online database setup could not be checked.',
    );
    process.exitCode = 1;
  } finally {
    await database.end();
  }
}

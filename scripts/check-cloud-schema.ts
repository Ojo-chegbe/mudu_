// Read-only installation check. Never print connection credentials or user data.
import { readFileSync, readdirSync } from 'node:fs';
import { onlineDatabase } from '../apps/host/online-postgres.ts';

const migrations = new URL('../supabase/migrations/', import.meta.url);
const files = readdirSync(migrations)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const readable = new Set([
  'mudu_exam_records',
  'mudu_bank_workspaces',
  'mudu_bank_projects',
  'mudu_bank_questions',
  'mudu_rosters',
  'mudu_roster_members',
  'mudu_roster_invites',
  'mudu_authoring_documents',
]);
const internal = new Set(['mudu_roster_index', 'mudu_roster_group']);
let database;
let client;
try {
  database = onlineDatabase(process.env);
  if (!database) throw new Error('Set MUDU_DATABASE_URL before checking the schema.');
  client = await database.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='15s'");
  const issues: string[] = [];
  for (const file of files) {
    const sql = readFileSync(new URL(file, migrations), 'utf8');
    let checks = 0;
    const before = issues.length;
    for (const match of sql.matchAll(/create table public\.(\w+)/gi)) {
      const name = match[1];
      const result = await client.query(
        `SELECT c.relrowsecurity AS rls,
        has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS anonymous_access,
        has_table_privilege('authenticated',c.oid,'SELECT') AS candidate_read,
        has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS direct_write
        FROM pg_class c WHERE c.oid=to_regclass($1)`,
        ['public.' + name],
      );
      const row = result.rows[0];
      if (
        !row?.rls ||
        row.anonymous_access ||
        row.direct_write ||
        row.candidate_read !== readable.has(name)
      )
        issues.push(name + ': missing table or unexpected access protection');
      checks++;
    }
    for (const match of sql.matchAll(/create function public\.(\w+)\(/gi)) {
      const name = match[1];
      const result = await client.query(
        `SELECT p.prosecdef AS definer,p.proconfig AS config,
        has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous_access,
        has_function_privilege('authenticated',p.oid,'EXECUTE') AS candidate_access,
        has_function_privilege('mudu_execution',p.oid,'EXECUTE') AS worker_access,
        EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_access
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`,
        [name],
      );
      const row = result.rows[0];
      const online = name.startsWith('mudu_online_');
      if (
        result.rows.length !== 1 ||
        row.public_access ||
        row.anonymous_access !== (name === 'mudu_roster_invitation') ||
        row.candidate_access !== (!online && !internal.has(name)) ||
        (online && !row.worker_access) ||
        (row.definer && !row.config?.some((value: string) => value.startsWith('search_path=')))
      )
        issues.push(name + ': missing function or unexpected execution permissions');
      checks++;
    }
    for (const match of sql.matchAll(/create policy (\w+) on public\.(\w+)/gi)) {
      const result = await client.query(
        'SELECT policyname FROM pg_policies WHERE schemaname=$1 AND tablename=$2 AND policyname=$3',
        ['public', match[2], match[1]],
      );
      if (result.rows.length !== 1) issues.push(match[1] + ': missing row-access policy');
      checks++;
    }
    console.log(
      `${issues.length === before ? 'PASS' : 'FAIL'} ${file} (${checks} schema/access checks)`,
    );
  }
  const role = (
    await client.query(
      "SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='mudu_execution'",
    )
  ).rows[0];
  if (!role || role.rolcanlogin || role.rolsuper || role.rolbypassrls)
    issues.push('Server examination role is missing or too privileged');
  await client.query('ROLLBACK');
  if (issues.length) {
    for (const issue of issues) console.error(issue);
    process.exitCode = 1;
  } else {
    console.log(
      'All six cloud migrations and expected access protections are installed. This is a schema check, not an end-to-end or load test.',
    );
  }
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  console.error(
    'Cloud schema check could not complete. Error code: ' +
      ((error as { code?: string }).code ?? 'CONFIGURATION_OR_CONNECTION'),
  );
  process.exitCode = 1;
} finally {
  client?.release();
  await database?.end();
}

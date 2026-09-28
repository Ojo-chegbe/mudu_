import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;',
  );
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version > 8) {
    db.close();
    throw new Error('This database needs a newer version of MUDU Host.');
  }
  if (version === 0) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE administrators (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, password_hash TEXT NOT NULL,
        singleton INTEGER NOT NULL UNIQUE CHECK(singleton = 1)
      ) STRICT;
      CREATE TABLE assessments (
        id TEXT PRIMARY KEY, definition TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE candidates (
        id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id),
        identifier TEXT NOT NULL, name TEXT NOT NULL, credential_hash TEXT NOT NULL,
        UNIQUE(assessment_id, identifier)
      ) STRICT;
      CREATE TABLE sittings (
        id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL UNIQUE REFERENCES assessments(id),
        code TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL,
        started_at INTEGER NOT NULL, deadline INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('admin','candidate')),
        principal_id TEXT NOT NULL, sitting_id TEXT REFERENCES sittings(id),
        csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX sessions_principal ON sessions(role, principal_id, sitting_id);
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY, sitting_id TEXT NOT NULL REFERENCES sittings(id),
        candidate_id TEXT NOT NULL REFERENCES candidates(id),
        status TEXT NOT NULL CHECK(status IN ('active','submitted','expired')),
        started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, submitted_at INTEGER,
        question_order TEXT NOT NULL,
        UNIQUE(sitting_id, candidate_id)
      ) STRICT;
      CREATE TABLE responses (
        attempt_id TEXT NOT NULL REFERENCES attempts(id), question_id TEXT NOT NULL,
        value TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), saved_at INTEGER NOT NULL,
        PRIMARY KEY(attempt_id, question_id)
      ) STRICT;
      CREATE TABLE operations (
        attempt_id TEXT NOT NULL REFERENCES attempts(id), operation_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL, receipt TEXT NOT NULL,
        PRIMARY KEY(attempt_id, operation_id)
      ) STRICT;
      CREATE TABLE events (
        id INTEGER PRIMARY KEY, sitting_id TEXT REFERENCES sittings(id),
        actor_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX events_sitting ON events(sitting_id, id);
      PRAGMA user_version = 1;
      COMMIT;`);
  }
  if (version < 2) {
    // Preserve an existing v1 database before applying the additive migration.
    if (version === 1 && path !== ':memory:' && !existsSync(`${path}.before-v2`)) {
      db.prepare('VACUUM INTO ?').run(`${path}.before-v2`);
    }
    transaction(db, () => {
      db.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
        INSERT INTO organizations VALUES('default', 'MUDU workspace');
        CREATE TABLE memberships (
          id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
          organization_id TEXT NOT NULL REFERENCES organizations(id), identifier TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','verified')), verified_at INTEGER,
          UNIQUE(account_id, organization_id)
        ) STRICT;
        CREATE UNIQUE INDEX verified_identity ON memberships(organization_id, identifier) WHERE status='verified';
        ALTER TABLE sessions ADD COLUMN account_id TEXT REFERENCES accounts(id);
        CREATE INDEX sessions_account ON sessions(account_id);
        CREATE TABLE registration_settings (
          assessment_id TEXT PRIMARY KEY REFERENCES assessments(id),
          organization_id TEXT NOT NULL DEFAULT 'default' REFERENCES organizations(id),
          mode TEXT NOT NULL CHECK(mode IN ('accounts','legacy')),
          policy TEXT NOT NULL CHECK(policy IN ('approval','roster')),
          link_token TEXT NOT NULL UNIQUE, is_open INTEGER NOT NULL CHECK(is_open IN (0,1)),
          closes_at INTEGER, capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 500)
        ) STRICT;
        INSERT INTO registration_settings(assessment_id,mode,policy,link_token,is_open,capacity)
          SELECT id,'legacy','approval',lower(hex(randomblob(24))),0,500 FROM assessments;
        CREATE TABLE registrations (
          id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id),
          account_id TEXT NOT NULL REFERENCES accounts(id),
          candidate_id TEXT UNIQUE REFERENCES candidates(id),
          status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
          requested_at INTEGER NOT NULL, reviewed_at INTEGER,
          UNIQUE(assessment_id, account_id)
        ) STRICT;
        CREATE INDEX registrations_assessment ON registrations(assessment_id, status);
        PRAGMA user_version = 2;
      `);
    });
  }
  if (version < 3) {
    transaction(db, () => {
      db.exec(`CREATE TABLE assessment_creations (
        admin_id TEXT NOT NULL REFERENCES administrators(id), request_id TEXT NOT NULL,
        assessment_id TEXT NOT NULL REFERENCES assessments(id),
        PRIMARY KEY(admin_id, request_id)
      ) STRICT;
      PRAGMA user_version = 3;`);
    });
  }
  if (version < 4)
    transaction(db, () => {
      db.exec(`CREATE TABLE manual_marks (
      attempt_id TEXT NOT NULL REFERENCES attempts(id), question_id TEXT NOT NULL,
      score REAL NOT NULL CHECK(score >= 0), revision INTEGER NOT NULL,
      reviewer_id TEXT NOT NULL, reviewed_at INTEGER NOT NULL,
      PRIMARY KEY(attempt_id, question_id)
    ) STRICT; PRAGMA user_version = 4;`);
    });
  if (version < 5)
    transaction(db, () => {
      db.exec(`CREATE TABLE notifications (
      recipient TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
      message TEXT NOT NULL, href TEXT NOT NULL, created_at INTEGER NOT NULL,
      read_at INTEGER, PRIMARY KEY(recipient,id)
    ) STRICT;
    CREATE INDEX notifications_feed ON notifications(recipient,created_at DESC);
    PRAGMA user_version = 5;`);
    });
  if (version < 6)
    transaction(db, () => {
      db.exec(`CREATE TABLE rosters (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE, restricted INTEGER NOT NULL, is_open INTEGER NOT NULL,
      archived INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE roster_entries (roster_id TEXT NOT NULL REFERENCES rosters(id), identifier TEXT NOT NULL,
      name TEXT NOT NULL, PRIMARY KEY(roster_id,identifier)) STRICT;
    CREATE TABLE roster_members (roster_id TEXT NOT NULL REFERENCES rosters(id), account_id TEXT NOT NULL REFERENCES accounts(id),
      status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')), requested_at INTEGER NOT NULL, reviewed_at INTEGER,
      PRIMARY KEY(roster_id,account_id)) STRICT;
    CREATE TABLE assessment_rosters (assessment_id TEXT PRIMARY KEY REFERENCES assessments(id),
      roster_id TEXT NOT NULL REFERENCES rosters(id), name TEXT NOT NULL, revision INTEGER NOT NULL) STRICT;
    PRAGMA user_version = 6;`);
    });
  if (version < 7) {
    if (version > 0 && path !== ':memory:' && !existsSync(`${path}.before-v7`))
      db.prepare('VACUUM INTO ?').run(`${path}.before-v7`);
    transaction(db, () => {
      db.exec(`CREATE TABLE application_numbers (
        registration_id TEXT PRIMARY KEY REFERENCES registrations(id),
        assessment_id TEXT NOT NULL REFERENCES assessments(id), serial INTEGER NOT NULL,
        UNIQUE(assessment_id,serial)
      ) STRICT;
      INSERT INTO application_numbers
        SELECT id,assessment_id,ROW_NUMBER() OVER(PARTITION BY assessment_id ORDER BY requested_at,id) FROM registrations;
      CREATE TRIGGER registration_application_number AFTER INSERT ON registrations BEGIN
        INSERT INTO application_numbers VALUES(NEW.id,NEW.assessment_id,
          (SELECT COALESCE(MAX(serial),0)+1 FROM application_numbers WHERE assessment_id=NEW.assessment_id));
      END;
      CREATE TABLE roster_enrolment_invites (
        id TEXT PRIMARY KEY, roster_id TEXT NOT NULL REFERENCES rosters(id),
        email TEXT NOT NULL, name TEXT NOT NULL, identifier TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
        claimed_account_id TEXT REFERENCES accounts(id), UNIQUE(roster_id,email)
      ) STRICT;
      CREATE INDEX enrolment_reserved_number ON roster_enrolment_invites(identifier);
      PRAGMA user_version = 7;`);
    });
  }
  if (version < 8) {
    if (version > 0 && path !== ':memory:' && !existsSync(`${path}.before-v8`))
      db.prepare('VACUUM INTO ?').run(`${path}.before-v8`);
    transaction(db, () =>
      db.exec(`
      CREATE TABLE bank_questions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','approved','archived')),
        revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('manual','ai')), evidence TEXT NOT NULL,
        model TEXT, creation_fingerprint TEXT NOT NULL
      ) STRICT;
      CREATE INDEX bank_owner_status ON bank_questions(owner_id,status,updated_at DESC);
      CREATE TABLE bank_revisions (
        question_id TEXT NOT NULL REFERENCES bank_questions(id), revision INTEGER NOT NULL,
        content TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(question_id,revision)
      ) STRICT;
      CREATE TABLE bank_generations (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
        created_at INTEGER NOT NULL, result TEXT NOT NULL, error TEXT NOT NULL
      ) STRICT;
      CREATE INDEX bank_generation_owner ON bank_generations(owner_id,created_at);
      PRAGMA user_version = 8;
    `),
    );
  }
  return db;
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

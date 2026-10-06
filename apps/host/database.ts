import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;',
  );
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version > 20) {
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
  if (version < 9) {
    if (version > 0 && path !== ':memory:' && !existsSync(`${path}.before-v9`))
      db.prepare('VACUUM INTO ?').run(`${path}.before-v9`);
    transaction(db, () => {
      db.exec(`
        CREATE TABLE bank_projects (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
          course TEXT NOT NULL, description TEXT NOT NULL,
          archived INTEGER NOT NULL CHECK(archived IN (0,1)),
          revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX bank_projects_owner ON bank_projects(owner_id,archived,updated_at DESC);
        CREATE TABLE bank_question_projects (
          question_id TEXT PRIMARY KEY REFERENCES bank_questions(id),
          project_id TEXT NOT NULL REFERENCES bank_projects(id)
        ) STRICT;
        CREATE INDEX bank_project_questions ON bank_question_projects(project_id,question_id);
        INSERT INTO bank_projects
          SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
            lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
            owner_id,'Imported questions','','Questions from your previous question bank.',0,1,MAX(updated_at)
          FROM bank_questions GROUP BY owner_id;
        INSERT INTO bank_question_projects
          SELECT q.id,p.id FROM bank_questions q JOIN bank_projects p ON p.owner_id=q.owner_id;
        CREATE TRIGGER bank_project_owner_insert BEFORE INSERT ON bank_question_projects
          WHEN (SELECT owner_id FROM bank_questions WHERE id=NEW.question_id) !=
            (SELECT owner_id FROM bank_projects WHERE id=NEW.project_id)
          BEGIN SELECT RAISE(ABORT,'Question and project owners must match'); END;
        CREATE TRIGGER bank_project_owner_update BEFORE UPDATE ON bank_question_projects
          WHEN (SELECT owner_id FROM bank_questions WHERE id=NEW.question_id) !=
            (SELECT owner_id FROM bank_projects WHERE id=NEW.project_id)
          BEGIN SELECT RAISE(ABORT,'Question and project owners must match'); END;
        PRAGMA user_version=9;
      `);
    });
  }
  if (version < 10) {
    if (version > 0 && path !== ':memory:' && !existsSync(`${path}.before-v10`))
      db.prepare('VACUUM INTO ?').run(`${path}.before-v10`);
    transaction(db, () =>
      db.exec(`CREATE TABLE bank_deleted_questions (
      question_id TEXT PRIMARY KEY REFERENCES bank_questions(id), actor_id TEXT NOT NULL,
      deleted_at INTEGER NOT NULL
    ) STRICT; PRAGMA user_version=10;`),
    );
  }
  if (version < 11) {
    transaction(db, () =>
      db.exec(`CREATE TABLE candidate_presence (
      sitting_id TEXT NOT NULL REFERENCES sittings(id),
      candidate_id TEXT NOT NULL REFERENCES candidates(id),
      last_seen_at INTEGER NOT NULL, reconnects INTEGER NOT NULL DEFAULT 0 CHECK(reconnects>=0),
      PRIMARY KEY(sitting_id,candidate_id)
    ) STRICT; PRAGMA user_version=11;`),
    );
  }
  if (version < 12) {
    transaction(db, () =>
      db.exec(`
      CREATE TABLE exam_controls (
        sitting_id TEXT PRIMARY KEY REFERENCES sittings(id), revision INTEGER NOT NULL DEFAULT 0,
        paused_at INTEGER, pause_total_ms INTEGER NOT NULL DEFAULT 0,
        extra_ms INTEGER NOT NULL DEFAULT 0, shared_deadline INTEGER
      ) STRICT;
      CREATE TABLE exam_announcements (
        id TEXT PRIMARY KEY, sitting_id TEXT NOT NULL REFERENCES sittings(id),
        message TEXT NOT NULL, actor_id TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX announcements_sitting ON exam_announcements(sitting_id,created_at);
      CREATE TABLE announcement_reads (
        announcement_id TEXT NOT NULL REFERENCES exam_announcements(id),
        candidate_id TEXT NOT NULL REFERENCES candidates(id), read_at INTEGER NOT NULL,
        PRIMARY KEY(announcement_id,candidate_id)
      ) STRICT;
      CREATE TABLE exam_control_receipts (
        sitting_id TEXT NOT NULL REFERENCES sittings(id), operation_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL,
        PRIMARY KEY(sitting_id,operation_id)
      ) STRICT;
      PRAGMA user_version=12;
    `),
    );
  }
  if (version < 13) {
    if (version > 0 && path !== ':memory:' && !existsSync(`${path}.before-v13`))
      db.prepare('VACUUM INTO ?').run(`${path}.before-v13`);
    // Rebuild only this table so the original Host account stays unique, while
    // cloud administrators can use NULL in the legacy singleton column.
    db.exec('PRAGMA foreign_keys=OFF');
    try {
      transaction(db, () => {
        db.exec(`
          CREATE TABLE administrators_next (
            id TEXT PRIMARY KEY,name TEXT NOT NULL,password_hash TEXT NOT NULL,
            singleton INTEGER UNIQUE CHECK(singleton=1)
          ) STRICT;
          INSERT INTO administrators_next SELECT * FROM administrators;
          DROP TABLE administrators;
          ALTER TABLE administrators_next RENAME TO administrators;
          CREATE TABLE admin_provider_identities (
            administrator_id TEXT PRIMARY KEY REFERENCES administrators(id),
            provider_user_id TEXT NOT NULL UNIQUE,email TEXT NOT NULL UNIQUE
          ) STRICT;
          CREATE TABLE provider_sessions (
            token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
            provider_user_id TEXT NOT NULL,access_token TEXT NOT NULL,
            refresh_token TEXT NOT NULL,expires_at INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE assessment_owners (
            assessment_id TEXT PRIMARY KEY REFERENCES assessments(id),owner_id TEXT NOT NULL
          ) STRICT;
          CREATE INDEX assessment_owner ON assessment_owners(owner_id,assessment_id);
          INSERT INTO assessment_owners
            SELECT a.id,MIN(e.actor_id) FROM assessments a JOIN events e
              ON e.kind='assessment_created' AND json_extract(e.detail,'$.assessmentId')=a.id
              GROUP BY a.id HAVING COUNT(DISTINCT e.actor_id)=1;
          INSERT OR IGNORE INTO assessment_owners
            SELECT assessment_id,MIN(admin_id) FROM assessment_creations
              GROUP BY assessment_id HAVING COUNT(DISTINCT admin_id)=1;
          INSERT OR IGNORE INTO assessment_owners
            SELECT a.id,r.owner_id FROM assessments a JOIN assessment_rosters l ON l.assessment_id=a.id
              JOIN rosters r ON r.id=l.roster_id;
          INSERT OR IGNORE INTO assessment_owners
            SELECT a.id,d.id FROM assessments a JOIN administrators d ON d.singleton=1;
        `);
        if (db.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error('Workspace migration could not preserve database references.');
        db.exec('PRAGMA user_version=13');
      });
    } finally {
      db.exec('PRAGMA foreign_keys=ON');
    }
  }
  if (version < 14) {
    if (version > 0 && path !== ':memory:' && !existsSync(`${path}.before-v14`))
      db.prepare('VACUUM INTO ?').run(`${path}.before-v14`);
    transaction(db, () =>
      db.exec(`
      CREATE TABLE cloud_instance (singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL);
      CREATE TABLE cloud_sync_jobs (
        id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES administrators(id),provider_user_id TEXT NOT NULL,
        assessment_id TEXT NOT NULL REFERENCES assessments(id),sitting_id TEXT NOT NULL,host_id TEXT NOT NULL,
        title TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,expected_revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','uploading','retry','conflict','synced')),
        parts INTEGER NOT NULL,uploaded INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0,error TEXT,synced_at INTEGER,revision INTEGER,created_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX cloud_pending_exam ON cloud_sync_jobs(owner_id,assessment_id) WHERE state!='synced';
      CREATE INDEX cloud_jobs_due ON cloud_sync_jobs(state,retry_at);
      PRAGMA user_version=14;
    `),
    );
  }
  if (version < 15) {
    if (version > 0 && path !== ':memory:' && !existsSync(`${path}.before-v15`))
      db.prepare('VACUUM INTO ?').run(`${path}.before-v15`);
    transaction(db, () =>
      db.exec(`
      CREATE TABLE candidate_provider_identities (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id),
        provider_user_id TEXT NOT NULL UNIQUE
      ) STRICT;
      PRAGMA user_version=15;
    `),
    );
  }
  if (version < 16) {
    if (version > 0 && path !== ':memory:' && !existsSync(`${path}.before-v16`))
      db.prepare('VACUUM INTO ?').run(`${path}.before-v16`);
    transaction(db, () =>
      db.exec(`
      CREATE TABLE authoring_drafts (
        id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES administrators(id),
        payload TEXT,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX authoring_draft_owner ON authoring_drafts(owner_id,id);
      PRAGMA user_version=16;
    `),
    );
  }
  if (version < 17) {
    if (version > 0 && path !== ':memory:' && !existsSync(`${path}.before-v17`))
      db.prepare('VACUUM INTO ?').run(`${path}.before-v17`);
    transaction(db, () =>
      db.exec(`
      CREATE TABLE local_preparations (
        id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES administrators(id),
        source_id TEXT NOT NULL REFERENCES assessments(id),run_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('pending','ready','completed','cancelled')),
        sealed TEXT NOT NULL,digest TEXT NOT NULL,source_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,error TEXT,
        downloaded INTEGER,cloud_closed INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE UNIQUE INDEX one_local_preparation ON local_preparations(source_id) WHERE state IN ('pending','ready');
      CREATE TABLE local_admission (
        preparation_id TEXT NOT NULL REFERENCES local_preparations(id),
        candidate_id TEXT NOT NULL REFERENCES candidates(id),account_id TEXT NOT NULL REFERENCES accounts(id),
        pass_hash TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(preparation_id,account_id)
      ) STRICT;
      CREATE TABLE offline_candidate_sessions (
        token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
        preparation_id TEXT NOT NULL REFERENCES local_preparations(id)
      ) STRICT;
      PRAGMA user_version=17;
    `),
    );
  }
  if (version < 18) {
    if (version > 0 && path !== ':memory:' && !existsSync(`${path}.before-v18`))
      db.prepare('VACUUM INTO ?').run(`${path}.before-v18`);
    transaction(db, () =>
      db.exec(`
      CREATE TABLE password_recovery (
        token_hash TEXT PRIMARY KEY, provider_user_id TEXT NOT NULL, proof_hash TEXT NOT NULL,
        encrypted_session TEXT NOT NULL, csrf TEXT NOT NULL,
        expires_at INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      PRAGMA user_version=18;
    `),
    );
  }
  if (version < 19) {
    if (version > 0 && path !== ':memory:' && !existsSync(`${path}.before-v19`))
      db.prepare('VACUUM INTO ?').run(`${path}.before-v19`);
    transaction(db, () =>
      db.exec(`
      CREATE TABLE admin_device_access (
        administrator_id TEXT PRIMARY KEY REFERENCES administrators(id) ON DELETE CASCADE,
        password_hash TEXT NOT NULL, enabled_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE admin_device_sessions (
        token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
        administrator_id TEXT NOT NULL REFERENCES admin_device_access(administrator_id) ON DELETE CASCADE
      ) STRICT;
      PRAGMA user_version=19;
    `),
    );
  }
  if (version < 20) {
    if (version > 0 && path !== ':memory:' && !existsSync(`${path}.before-v20`))
      db.prepare('VACUUM INTO ?').run(`${path}.before-v20`);
    transaction(db, () =>
      db.exec(`
      CREATE TABLE workspace_connections (
        token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK(mode IN ('auto','offline')),
        state TEXT NOT NULL CHECK(state IN ('online','offline')),
        checked_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE account_preferences (
        principal_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','candidate')),
        text_size TEXT NOT NULL CHECK(text_size IN ('normal','large')),
        reduced_motion TEXT NOT NULL CHECK(reduced_motion IN ('system','reduce')),
        notification_badge INTEGER NOT NULL CHECK(notification_badge IN (0,1)),
        offline_setup_completed INTEGER NOT NULL DEFAULT 0 CHECK(offline_setup_completed IN (0,1)),
        PRIMARY KEY(role,principal_id)
      ) STRICT;
      INSERT INTO account_preferences SELECT administrator_id,'admin','normal','system',1,1 FROM admin_device_access;
      INSERT OR IGNORE INTO account_preferences SELECT a.id,'admin','normal','system',1,1 FROM administrators a JOIN events e ON e.actor_id=a.id AND e.kind='device_access_enabled' GROUP BY a.id;
      PRAGMA user_version=20;
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

# Question bank and AI-assisted authoring

## Administrator workflow

Open **Question bank** in the sidebar to see your projects. Create a project for a course, topic
or examination, with a name, optional subject and description. Each project shows its question
count, ready-to-use and needs-review counts, and last updated date. Search projects by name,
subject or description; archived projects have their own view.

Open a project and choose **Write question** or **Generate from notes**. Questions and generated
drafts save directly into that project. New-question and generation drafts are kept separately
for each project in this tab. After saving or reviewing, return to the same project.
Questions support multiple choice, multiple select (exact-match scoring), and written answers.
Add a subject, topic, difficulty, tags and an explanation or marking guide. Save unfinished work
as a draft. Review the wording, correct answers and marks, then explicitly approve the question.

Each project separates **Ready to use**, **Needs review** and **Archived**. Search spans question
text, subject, topic and tags. Type/difficulty filters combine with search. Lists are paginated.
Archived questions can be restored by reviewing and approving them again. Delete removes questions
from the bank and assessment selection; stored audit history and existing assessment copies remain.
Reviewers can approve or delete a question from its editor. Select multiple questions in a project
or the generated-question review screen to approve or delete them together. Bulk approval requires
explicit lecturer confirmation and saves inline edits. Bulk actions validate all selected revisions,
ownership, project availability and answer structure before committing any changes.

The project workspace initially shows drafts and approved questions together, with archived questions
in a separate view. Search remains visible; type and difficulty filters expand when needed. Editing
and returning to the project preserves the current filters and page. Answer previews avoid repeating
the prompt. Selection actions appear only while questions are selected.

Project settings let you rename a project, edit its subject/description, archive it or restore it.
Archiving retains all questions but prevents authoring and assessment selection until restored.
Select questions inside an active project and choose **Move to project** to reorganize them.
Moves keep approval and revision history; stale or unauthorized moves are rejected atomically.

In assessment creation or editing, choose **Add from question bank**, then browse your projects.
Preview answers and select multiple approved questions, including across pages and projects.
Selection is kept when returning to the project list. The server rechecks ownership, project availability, approval and
revision before returning independent copies. These copies enter the existing assessment draft
workflow. Later bank changes never modify an assessment definition, sitting, answers or grades.

## Operator-managed AI setup

1. Create a Google AI Studio API key in a project without billing for free-tier use.
2. As the platform operator, put `MUDU_GOOGLE_AI_KEY=your-key` in the project-root `.env` file,
   or set it in the server environment/secret manager. `.env.example` is the blank template.
   `npm run dev`, `npm run dev:host` and `npm start` load `.env` for the Host automatically;
   missing files are allowed and existing process variables take priority. Restart after editing.
   Never use a `VITE_` variable, commit a key, or distribute it with a Host installer.
3. Lecturers open **Question bank → a project → Generate from notes**, supply their material and generate.
   They do not configure API keys or provider settings. Candidates have no access to these APIs.

The key is read from the server environment at startup, including the local `.env` loaded by Node. There is no browser key-entry UI and
no API for reading or changing provider configuration, including for lecturers with administrator
access. The availability endpoint returns only availability, a user-facing message and retry time.
Rotate or remove the key through server configuration and restart. Missing configuration and provider
authentication failures produce an availability message rather than asking lecturers for a key.

Upload a PDF, Word `.docx`, PowerPoint `.pptx`, OpenDocument `.odt`, text `.txt` or Markdown `.md`
document (up to 10 MB). Upload is the primary action; pasting text is a secondary expandable option.
The Host extracts text locally without calling Google or storing the original file. After extraction,
the page shows the filename, page/slide count where available, warnings and an expandable editable
preview. Failed uploads leave previous material unchanged; replacing it requires confirmation.

Generation accepts 100–60,000 characters. Extraction can return up to 300,000 characters; longer
source text opens the preview and blocks generation until the user deliberately shortens it.
There is no silent truncation. PDFs and presentations are limited to 200 pages/slides. Images,
scans, charts, speaker notes and embedded objects are not read. Mixed scanned/text PDFs warn about
pages with no selectable text; image-only documents fail with guidance. Password-protected PDFs
and encrypted Office files require an unlocked copy. Older `.doc`/`.ppt` files must be exported
to `.docx`/`.pptx`. Text decoding accepts UTF-8 and BOM-marked UTF-16.

Choose a subject, optional topic, type, difficulty and 1–10 questions. Accept the data-sharing notice,
generate and review drafts before approval. Uploading or editing source text resets consent.
Manual authoring remains available when generation is unavailable.

The only configured endpoint/model is Google's `gemma-4-26b-a4b-it` generateContent API.
No model switching, automatic retries, paid fallback, grounding, browsing or tool execution occurs.
Google controls quotas, eligibility, availability and pricing; MUDU cannot inspect a project's billing
status or promise permanent zero cost. Use an unbilled project and check provider terms.

Google's free-tier terms permit product-improvement use of submitted content. Do not send candidate
information, confidential examination content or source material without sharing permission.
Only the notes and generation settings are transmitted, never the candidate roster or existing bank.

Reference documentation:

- https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/terms

## Reliability and security boundaries

- Administrator-only APIs, existing loopback administration boundary and CSRF checks on writes.
- Source text is treated as untrusted data, not instructions; output is parsed and validated as data.
- Generated questions must have valid answer mappings, distinct options, the requested type and
  count and non-duplicate prompts. These are structural checks, not an accuracy review.
  Source excerpts are neither requested nor checked. Lecturers alone review accuracy, relevance,
  answers and marks, and explicitly approve questions before use in the bank picker.
- AI output never becomes approved automatically. Invalid batches are rejected atomically.
- Generated output accepts the canonical nested question record and complete flat records using
  question text or a prompt, wrapped in a questions object or a top-level array. Normalisation only
  changes layout; it never guesses answer keys or invents missing fields. Invalid records return
  a question-specific, user-facing error instead of internal object-validation messages.
- API key is not returned, stored in browser storage, written to the database or put in request URLs.
- No application-imposed daily, per-user, shared or concurrent AI-generation caps. Google's own
  rate limits and quotas still apply and cannot be disabled by MUDU. Duplicate request IDs remain
  idempotent. Login abuse protections and document-processing safety limits remain enabled.
- A 90-second provider timeout, bounded source/output sizes, and no automatic quota retries.
- Generation IDs are durable and fingerprinted. Retrying the same request returns its existing
  result; requests with changed settings cannot silently reuse an ID. A refreshed page checks the
  existing request. Interrupted jobs become failed after two minutes and can be explicitly retried
  as new requests. Authentication is checked again before generated content is committed.
- The database stores content revisions, metadata and provider identity, not the full uploaded
  document or source notes. Legacy source excerpts are preserved but no longer displayed or
  collected for new drafts. Source/settings remain in tab session storage
  while authoring. Signing out clears this tab's drafts; use a trusted administrator browser.
- Manual authoring, review and assessment reuse work without internet. Hosted generation needs
  internet. The local examination engine has no dependency on the AI service.
- Schema v9 adds projects and question membership without rewriting question content. Existing
  questions are placed in one **Imported questions** project per owner. Question IDs, approvals,
  revisions, historical generations and assessment copies are preserved. An existing database is
  snapshotted before the migration; migration and project membership changes are transactional.
- Schema v10 adds durable deletion records. Deleted questions remain absent after refresh/restart,
  including when reopening a past generated batch. Historical question revisions are retained.
- Document upload requires administrator authentication and CSRF verification, including a second
  authentication check after parsing. Uploaded bytes never become public URLs or permanent files.
- Parsing runs in isolated workers without inherited environment secrets, with a 25-second timeout,
  a 256 MB V8 heap limit, bounded archives/XML, no custom XML entities and no external document
  relationships resolved. Only two upload/extraction requests can be active in the Host process.
  Parser diagnostics are discarded rather than logging document fragments. Worker isolation and
  limits reduce resource risk; they are not a claim of a full operating-system sandbox.

## Scope and verification

This implementation manages one server deployment and its shared database. Independently installed
Hosts do not share quota state. A future hosted AI gateway must hold the operator key and central
usage records when serving multiple distributed Hosts; never ship the operator key to lecturers.

OCR, legacy binary Office formats, local-model hosting, cloud bank synchronization, advanced bulk
imports, multi-document merging and a revision-history browsing UI are not implemented in this slice.
Revision records are stored for audit, but the current UI edits only the current version.

Automated tests cover approval validation, stale writes, owner isolation, independent assessment
copies, pagination, retry safety, malformed output, non-blocking source references, concurrency, authorisation,
quota handling, API boundaries, project isolation, moves, archiving, generation during project
changes, and v7/v8 migration/reopen persistence. Provider responses are mocked;
live generation requires a configured key. A two-question live Gemma smoke test with synthetic notes
passed after the response-parser fix. This does not verify generation quality for every uploaded
document. Run `node --env-file-if-exists=.env scripts/check-ai.ts` for an explicit one-request smoke
test; it opens only an in-memory database and never sends uploaded user documents. Physical UI
verification requires an available browser.
Document tests use representative in-memory PDF and Office structures, exercise isolated workers,
and check text decoding, slide order, archive/XML limits, image-only failures and HTTP access controls.
Complex real-world layouts still require review of the extracted-text preview.

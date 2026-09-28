import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { extractDocument } from '../apps/host/document-extraction.ts';
import { readDocumentInWorker } from '../apps/host/document-upload.ts';
import { maxDocumentBytes, maxExtractedCharacters } from '../packages/contracts/documents.ts';
import { openDatabase } from '../apps/host/database.ts';
import { createHandler } from '../apps/host/http.ts';
import { ExamStore } from '../apps/host/store.ts';

const notes =
  'The nucleus contains genetic material. The cell wall supports the cell. These notes describe cell structures and their functions for introductory biology.';
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Small, uncompressed in-memory Office fixtures; no external files or office application required.
function zip(entries: Record<string, string>) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(value);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, data);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function pdf(text: string) {
  const stream = `BT /F1 10 Tf 30 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let value = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(value));
    value += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(value);
  value += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(value);
}

test('text and Markdown extraction supports Unicode, rejects binary files and never truncates silently', async () => {
  assert.equal((await extractDocument('notes.TXT', Buffer.from(notes))).text, notes);
  assert.equal(
    (
      await extractDocument(
        'notes.md',
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(notes, 'utf16le')]),
      )
    ).text,
    notes,
  );
  const long = await extractDocument('long.txt', Buffer.from('a'.repeat(60001)));
  assert.equal(long.text.length, 60001);
  await assert.rejects(
    extractDocument('huge.txt', Buffer.from('a'.repeat(maxExtractedCharacters + 1))),
    /too much text/,
  );
  await assert.rejects(
    extractDocument('notes.txt', Buffer.from([0xff, 0, 0, 1])),
    /UTF-8|readable text/,
  );
  await assert.rejects(extractDocument('notes.txt', Buffer.from('short')), /Not enough readable/);
  await assert.rejects(extractDocument('notes.doc', Buffer.from(notes)), /older .doc/);
  await assert.rejects(extractDocument('notes.txt', Buffer.alloc(maxDocumentBytes + 1)), /10 MB/);
});

test('Word body and table text are extracted without evaluating fields or deleted text', async () => {
  const file = zip({
    'word/document.xml': `<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>${notes}</w:t></w:r></w:p><w:del><w:r><w:t>DELETED</w:t></w:r></w:del><w:p><w:r><w:instrText>EXTERNAL FIELD</w:instrText></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table text</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
  });
  const result = await extractDocument('notes.docx', file);
  assert.match(result.text, /Table text/);
  assert.match(result.text, /nucleus/);
  assert.doesNotMatch(result.text, /DELETED|EXTERNAL FIELD/);
  await assert.rejects(
    extractDocument('wrong.docx', zip({ 'content.xml': '<document/>' })),
    /does not match/,
  );
  await assert.rejects(
    extractDocument('broken.docx', Buffer.from('not a zip')),
    /encrypted, damaged/,
  );
});

test('OpenDocument validates the container type and decodes paragraphs and entities', async () => {
  const file = zip({
    mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml': `<office:document xmlns:office="urn:office" xmlns:text="urn:text"><text:p>${notes}</text:p><text:p>A &amp; B</text:p></office:document>`,
  });
  const result = await extractDocument('notes.odt', file);
  assert.match(result.text, /A & B/);
  await assert.rejects(
    extractDocument('bad.odt', zip({ mimetype: 'application/other', 'content.xml': '<text/>' })),
    /does not match/,
  );
});

test('PowerPoint follows presentation slide order, not filenames, and does not resolve external slides', async () => {
  const parts = {
    'ppt/presentation.xml':
      '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      '<Relationships><Relationship Id="first" Type="urn:test/slide" Target="slides/slide1.xml"/><Relationship Id="second" Type="urn:test/slide" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>LAST ${notes}</a:t></a:r></a:p></p:sld>`,
    'ppt/slides/slide2.xml': `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>FIRST ${notes}</a:t></a:r></a:p></p:sld>`,
  };
  const result = await extractDocument('lecture.pptx', zip(parts));
  assert.ok(result.text.startsWith('FIRST'));
  assert.equal(result.units, 2);
  assert.equal(result.unitLabel, 'slides');
  parts['ppt/_rels/presentation.xml.rels'] =
    '<Relationships><Relationship Id="second" Type="urn:test/slide" TargetMode="External" Target="https://example.test/slide"/></Relationships>';
  await assert.rejects(extractDocument('external.pptx', zip(parts)), /linked outside/);
});

test('XML entity declarations and oversized archive sections are rejected', async () => {
  const entity = zip({
    'word/document.xml':
      '<!DOCTYPE doc [<!ENTITY secret SYSTEM "file:///not-read">]><doc>&secret;</doc>',
  });
  await assert.rejects(extractDocument('entity.docx', entity), /custom XML entities/);
  const large = zip({ 'word/document.xml': ' '.repeat(4 * 1024 * 1024 + 1) });
  await assert.rejects(extractDocument('large.docx', large), /section is too large/);
});

test('PDF text is extracted in the isolated worker; blank/image-only PDFs are actionable failures', async () => {
  const result = await readDocumentInWorker('reading.pdf', pdf(notes));
  assert.match(result.text, /nucleus contains genetic material/);
  assert.equal(result.units, 1);
  await assert.rejects(readDocumentInWorker('scan.pdf', pdf('')), /scanned or image-only/);
  await assert.rejects(extractDocument('fake.pdf', Buffer.from(notes)), /not a valid PDF/);
  assert.equal((await readDocumentInWorker('notes.txt', Buffer.from(notes))).text, notes);
});

test('document upload requires admin authentication and CSRF, enforces size/type, and returns text only', async (t) => {
  const db = openDatabase(':memory:');
  const store = new ExamStore(db);
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', await createHandler(db, { origin }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const admin = store.createSession('admin', 'admin', null);
  const candidate = store.createSession('candidate', 'candidate', null);
  const endpoint = `${origin}/api/question-bank/documents/extract?name=notes.txt`;
  const headers = {
    Origin: origin,
    'Content-Type': 'application/octet-stream',
    Cookie: `mudu_session=${admin.raw}`,
  };
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        body: notes,
        headers: { Origin: origin, 'Content-Type': 'application/octet-stream' },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        body: notes,
        headers: {
          ...headers,
          Cookie: `mudu_session=${candidate.raw}`,
          'X-CSRF-Token': candidate.csrf,
        },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(endpoint, { method: 'POST', body: notes, headers })).status, 403);
  const authorized = { ...headers, 'X-CSRF-Token': admin.csrf };
  const response = await fetch(endpoint, { method: 'POST', body: notes, headers: authorized });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, notes);
  assert.equal(
    (
      await fetch(endpoint.replace('notes.txt', 'notes.doc'), {
        method: 'POST',
        body: notes,
        headers: authorized,
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        body: Buffer.alloc(maxDocumentBytes + 1),
        headers: authorized,
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        body: notes,
        headers: { ...authorized, 'Content-Type': 'application/json' },
      })
    ).status,
    415,
  );
});

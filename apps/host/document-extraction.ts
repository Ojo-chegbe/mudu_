import { fromBuffer } from 'yauzl';
import type { Entry } from 'yauzl';
import { SaxesParser } from 'saxes';
import {
  documentExtensions,
  maxDocumentBytes,
  maxExtractedCharacters,
} from '../../packages/contracts/documents.ts';
import type { ExtractedDocument } from '../../packages/contracts/documents.ts';

function fail(message: string): never {
  throw new Error(message);
}
function checkLength(text: string) {
  if (text.length > maxExtractedCharacters)
    fail('This document contains too much text. Upload a chapter or a shorter document instead.');
  return text;
}
function decode(bytes: Uint8Array) {
  try {
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : 'utf-8';
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (text.includes('\0'))
      fail('This is not a readable text document. Save it as UTF-8 text and upload again.');
    return text;
  } catch {
    return fail('This file could not be read as text. Save it as UTF-8 and try again.');
  }
}
function xmlText(xml: string, format: string) {
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  let capture = 0;
  let output = '';
  let hidden = 0;
  const stack: { capture: boolean; hidden: boolean }[] = [];
  parser.on('doctype', () =>
    fail('Documents with custom XML entities are not supported. Export a new copy and try again.'),
  );
  parser.on('opentag', (tag) => {
    if (++depth > 100)
      fail('This document is too complex to read safely. Export it as PDF or text.');
    const local = tag.local;
    const hide = format === 'docx' && ['del', 'instrText'].includes(local);
    if (hide) hidden++;
    const take = format === 'odt' ? ['p', 'h'].includes(local) : local === 't';
    if (take) capture++;
    stack.push({ capture: take, hidden: hide });
    if (!hidden && ['tab', 'line-break', 'br'].includes(local)) output += ' ';
    if (format === 'odt' && local === 's' && capture) output += ' ';
  });
  const append = (value: string) => {
    if (capture && !hidden) output = checkLength(output + value);
  };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', (tag) => {
    const current = stack.pop()!;
    if (!hidden && ['p', 'h', 'tr', 'table-row'].includes(tag.local)) output += '\n';
    if (current.capture) capture--;
    if (current.hidden) hidden--;
    depth--;
  });
  parser.write(xml).close();
  return checkLength(output);
}
function officeParts(buffer: Buffer, format: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip)
          return reject(
            new Error(
              'This document is damaged or is not the selected file type. Export a new copy and try again.',
            ),
          );
        const parts = new Map<string, string>();
        let total = 0;
        let entries = 0;
        let failed = false;
        const rejectOnce = (error: unknown) => {
          if (!failed) {
            failed = true;
            zip.close();
            reject(error);
          }
        };
        zip.on('error', () =>
          rejectOnce(
            new Error('The document archive is damaged. Export a new copy and try again.'),
          ),
        );
        zip.on('entry', (entry: Entry) => {
          if (failed) return;
          total += entry.uncompressedSize;
          if (
            ++entries > 3000 ||
            total > 50 * 1024 * 1024 ||
            entry.uncompressedSize > 20 * 1024 * 1024
          )
            return rejectOnce(
              new Error(
                'This document expands beyond the safe reading limit. Upload a smaller document.',
              ),
            );
          if (entry.generalPurposeBitFlag & 1)
            return rejectOnce(
              new Error('Password-protected documents cannot be read. Upload an unlocked copy.'),
            );
          const name = entry.fileName;
          const wanted =
            format === 'docx'
              ? name === 'word/document.xml'
              : format === 'odt'
                ? name === 'content.xml' || name === 'mimetype'
                : /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
                  name === 'ppt/presentation.xml' ||
                  name === 'ppt/_rels/presentation.xml.rels';
          if (!wanted) {
            zip.readEntry();
            return;
          }
          if (parts.has(name))
            return rejectOnce(
              new Error('This document contains duplicate sections. Export a new copy.'),
            );
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream)
              return rejectOnce(new Error('A document section could not be read.'));
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on('data', (chunk) => {
              size += chunk.length;
              if (size > 4 * 1024 * 1024) {
                stream.destroy();
                rejectOnce(
                  new Error('A document section is too large. Upload a smaller document.'),
                );
              } else chunks.push(chunk);
            });
            stream.on('error', () => rejectOnce(new Error('A document section is damaged.')));
            stream.on('end', () => {
              if (failed) return;
              try {
                parts.set(name, decode(Buffer.concat(chunks)));
                zip.readEntry();
              } catch (e) {
                rejectOnce(e);
              }
            });
          });
        });
        zip.on('end', () => {
          if (!failed) resolve(parts);
        });
        zip.readEntry();
      },
    );
  });
}
function slideOrder(parts: Map<string, string>) {
  const ids: string[] = [];
  const relationships = new Map<string, string>();
  const presentation = parts.get('ppt/presentation.xml');
  const rels = parts.get('ppt/_rels/presentation.xml.rels');
  if (!presentation || !rels)
    fail('This is not a valid PowerPoint presentation. Export a new .pptx copy.');
  const read = (xml: string, action: (name: string, attrs: Record<string, string>) => void) => {
    const parser = new SaxesParser();
    parser.on('doctype', () => fail('Custom XML entities are not supported.'));
    parser.on('opentag', (tag) => action(tag.name, tag.attributes as Record<string, string>));
    parser.write(xml).close();
  };
  read(presentation, (name, attrs) => {
    if (name.endsWith(':sldId')) ids.push(attrs['r:id']);
  });
  read(rels, (name, attrs) => {
    if (
      name !== 'Relationship' ||
      attrs.TargetMode === 'External' ||
      !attrs.Type?.endsWith('/slide')
    )
      return;
    const target = attrs.Target?.replace(/^\/ppt\//, '').replace(/^\.\//, '');
    if (/^slides\/slide\d+\.xml$/.test(target)) relationships.set(attrs.Id, `ppt/${target}`);
  });
  if (!ids.length || ids.length > 200) fail('Use a presentation with 1–200 slides.');
  return ids.map((id) => {
    const path = relationships.get(id);
    if (!path || !parts.has(path))
      fail('A slide is missing or linked outside this file. Export a complete .pptx copy.');
    return path;
  });
}
export async function extractDocument(name: string, bytes: Uint8Array): Promise<ExtractedDocument> {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (!(documentExtensions as readonly string[]).includes(extension))
    fail(
      'Use PDF, DOCX, PPTX, ODT, TXT or Markdown. For older .doc/.ppt files, save a .docx/.pptx copy first.',
    );
  if (!bytes.length || bytes.length > maxDocumentBytes)
    fail('Choose a non-empty document no larger than 10 MB.');
  const result: ExtractedDocument = {
    name: name.slice(0, 200),
    text: '',
    units: null,
    unitLabel: null,
    warnings: [],
  };
  const buffer = Buffer.from(bytes);
  if (extension === 'txt' || extension === 'md') result.text = checkLength(decode(bytes));
  else if (extension === 'pdf') {
    if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      fail('This file is not a valid PDF. Export it as PDF and try again.');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
      disableFontFace: true,
      useWasm: false,
      useWorkerFetch: false,
      verbosity: 0,
    });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 200)
        fail('This PDF has more than 200 pages. Upload a chapter or selected pages.');
      result.units = pdf.numPages;
      result.unitLabel = 'pages';
      let emptyPages = 0;
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
          .join('')
          .trim();
        if (!text) emptyPages++;
        else result.text = checkLength(result.text + text + '\n\n');
        page.cleanup();
      }
      if (emptyPages)
        result.warnings.push(
          `${emptyPages} of ${pdf.numPages} pages contained no selectable text. Scanned pages and images are not read; check that the preview includes everything you need.`,
        );
      result.warnings.push(
        'Images and diagrams are not read. PDF columns, tables and equations may lose their layout. Review the extracted text before generating.',
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'PasswordException')
        fail('This PDF is password-protected. Upload an unlocked copy.');
      if (
        error instanceof Error &&
        ['InvalidPDFException', 'UnknownErrorException'].includes(error.name)
      )
        fail('This PDF could not be read. Export a new copy and try again.');
      throw error;
    } finally {
      await task.destroy();
    }
  } else {
    if (!buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
      fail(
        'This file is encrypted, damaged or not a supported Office document. Upload an unlocked DOCX, PPTX or ODT copy.',
      );
    const parts = await officeParts(buffer, extension);
    if (extension === 'pptx') {
      const paths = slideOrder(parts);
      result.units = paths.length;
      result.unitLabel = 'slides';
      result.text = checkLength(
        paths.map((path) => xmlText(parts.get(path)!, extension)).join('\n\n'),
      );
      result.warnings.push(
        'Slide text is included. Speaker notes, images, charts and equations are not read.',
      );
    } else {
      const xml = parts.get(extension === 'docx' ? 'word/document.xml' : 'content.xml');
      if (
        !xml ||
        (extension === 'odt' && parts.get('mimetype') !== 'application/vnd.oasis.opendocument.text')
      )
        fail('The document type does not match its contents. Export a new copy and try again.');
      result.text = xmlText(xml, extension);
      result.warnings.push(
        'Body text and table text are included. Images, embedded objects, comments and some equations are not read.',
      );
    }
  }
  result.text = checkLength(
    result.text
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
  if (result.text.length < 100)
    fail(
      'Not enough readable text was found. This may be a scanned or image-only document. Use a text-based copy or paste at least 100 characters; OCR is not available yet.',
    );
  return result;
}

import { useEffect, useRef, useState } from 'react';
import {
  documentAccept,
  documentExtensions,
  maxDocumentBytes,
  maxExtractedCharacters,
  maxGenerationCharacters,
} from '../../packages/contracts/documents.ts';
import type { ExtractedDocument } from '../../packages/contracts/documents.ts';
import { extractDocumentFile, errorMessage } from './api.ts';
import { Dialog, Icon, Notice } from './ui.tsx';

export type SourceDocument = Omit<ExtractedDocument, 'text'>;
export function DocumentSource({
  source,
  document: currentDocument,
  disabled,
  onChange,
  onBusy,
}: {
  source: string;
  document: SourceDocument | null;
  disabled: boolean;
  onChange: (text: string, document: SourceDocument | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [reading, setReading] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [paste, setPaste] = useState(Boolean(source && !currentDocument));
  const [pending, setPending] = useState<ExtractedDocument | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      onBusy(false);
    };
  }, [onBusy]);
  function accept(result: ExtractedDocument) {
    const { text, ...metadata } = result;
    onChange(text, metadata);
    setPaste(false);
    setPending(null);
  }
  async function read(files: FileList | File[]) {
    if (disabled || reading || pending) return;
    setDragging(false);
    setError('');
    if (files.length !== 1) {
      setError('Choose one document at a time. You can replace it before generating.');
      return;
    }
    const file = files[0];
    if (
      !(documentExtensions as readonly string[]).includes(
        file.name.split('.').pop()?.toLowerCase() ?? '',
      )
    ) {
      setError(
        'Use PDF, DOCX, PPTX, ODT, TXT or Markdown. Save older .doc or .ppt files as .docx or .pptx first.',
      );
      return;
    }
    if (!file.size || file.size > maxDocumentBytes) {
      setError('Choose a non-empty document no larger than 10 MB.');
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setReading(file.name);
    onBusy(true);
    try {
      const result = await extractDocumentFile(
        file,
        AbortSignal.any([abort.signal, AbortSignal.timeout(45000)]),
      );
      if (!mounted.current || abort.signal.aborted) return;
      if (source.trim()) setPending(result);
      else accept(result);
    } catch (e) {
      if (mounted.current && !abort.signal.aborted) setError(errorMessage(e));
    } finally {
      if (mounted.current) {
        setReading('');
        onBusy(false);
      }
    }
  }
  const blocked = disabled || Boolean(reading) || Boolean(pending);
  const tooLong = source.length > maxGenerationCharacters;
  return (
    <section className="panel padded document-source">
      <div className="section-heading">
        <div>
          <h2>Add your material</h2>
          <p className="field-hint">Upload lecture notes, a presentation or a reading document.</p>
        </div>
      </div>
      <input
        ref={input}
        className="sr-only"
        type="file"
        aria-label="Choose source document"
        accept={documentAccept}
        disabled={blocked}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void read(files);
        }}
      />
      <div
        className={`document-dropzone${dragging ? ' dragging' : ''}${currentDocument ? ' has-document' : ''}`}
        aria-busy={Boolean(reading)}
        onDragOver={(e) => {
          e.preventDefault();
          if (!blocked) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!blocked) void read(e.dataTransfer.files);
        }}
      >
        {reading ? (
          <div className="document-reading" role="status">
            <span className="spinner" />
            <strong>Preparing {reading}…</strong>
            <button
              type="button"
              className="text-button"
              onClick={() => controller.current?.abort()}
            >
              Cancel
            </button>
          </div>
        ) : currentDocument ? (
          <div className="document-file">
            <Icon name="paper" size={28} />
            <div>
              <strong>{currentDocument.name}</strong>
              {currentDocument.units && (
                <p className="field-hint">
                  {currentDocument.units} {currentDocument.unitLabel}
                </p>
              )}
              <span className="document-ready">
                <Icon name="check" size={14} />
                {tooLong
                  ? 'Choose a shorter section'
                  : source.trim().length < 100
                    ? 'More material needed'
                    : 'Ready to generate'}
              </span>
            </div>
            <button
              type="button"
              className="text-button"
              disabled={blocked}
              onClick={() => input.current?.click()}
            >
              Replace file
            </button>
          </div>
        ) : (
          <>
            <Icon name="paper" size={32} />
            <h3>Drop your document here</h3>
            <button
              type="button"
              className="button primary"
              disabled={blocked}
              onClick={() => input.current?.click()}
            >
              Choose file
            </button>
            <p className="field-hint">
              PDF, Word (.docx), PowerPoint (.pptx), OpenDocument (.odt), TXT or Markdown
              <br />
              Up to 10 MB · one document at a time
            </p>
          </>
        )}
      </div>
      {error && (
        <Notice>
          {error}
          {source && ' Your previous source material is unchanged.'}
        </Notice>
      )}
      {currentDocument?.warnings.map((warning) => (
        <p key={warning} className="field-hint document-warning">
          {warning}
        </p>
      ))}
      {tooLong && (
        <Notice>
          This document is too long for one set of questions. Use the preview below to keep only the
          sections you need.
        </Notice>
      )}
      {currentDocument && (
        <details className="document-preview" open={tooLong}>
          <summary>Preview material</summary>
          <label>
            Text to use
            <textarea
              rows={6}
              maxLength={maxExtractedCharacters}
              value={source}
              disabled={blocked}
              onChange={(e) => onChange(e.target.value, currentDocument)}
            />
          </label>
          <p className="field-hint">{source.length.toLocaleString()} / 60,000 characters</p>
        </details>
      )}
      {!currentDocument && (
        <div className="document-paste">
          <button
            type="button"
            className="text-button"
            aria-expanded={paste}
            aria-controls="paste-source"
            disabled={blocked}
            onClick={() => setPaste(!paste)}
          >
            {paste ? 'Hide pasted text' : 'Or paste text instead'}
          </button>
          {paste && (
            <label id="paste-source">
              Source text
              <textarea
                rows={4}
                maxLength={maxGenerationCharacters}
                value={source}
                disabled={blocked}
                placeholder="Paste the relevant passage…"
                onChange={(e) => onChange(e.target.value, null)}
              />
            </label>
          )}
        </div>
      )}
      {source && (!currentDocument || source.trim().length < 100) && (
        <div className="document-source-count">
          <span className="field-hint">
            {source.length.toLocaleString()} / 60,000 characters for generation
            {source.trim().length < 100 ? ' · add at least 100 characters' : ''}
          </span>
        </div>
      )}
      {pending && (
        <Dialog
          title="Replace your source material?"
          confirmLabel="Use this document"
          onClose={() => setPending(null)}
          confirm={() => accept(pending)}
        >
          <p>
            Use <strong>{pending.name}</strong> instead? This replaces your current material and any
            edits. Your question settings stay unchanged.
          </p>
        </Dialog>
      )}
    </section>
  );
}

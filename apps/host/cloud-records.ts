import { createClient } from '@supabase/supabase-js';
import type { CloudExamRecord, CloudRecordSummary } from '../../packages/contracts/cloud-sync.ts';
import { DomainError } from '../../packages/exam-core/model.ts';

export interface UploadManifest {
  id: string;
  recordId: string;
  sittingId: string;
  hostId: string;
  expectedRevision: number;
  digest: string;
  byteLength: number;
  parts: number;
}
export interface UploadReceipt {
  id: string;
  revision: number;
  digest: string;
}
export interface CloudRecords {
  ready(accessToken: string): Promise<void>;
  begin(
    accessToken: string,
    manifest: UploadManifest,
  ): Promise<{ received: number[]; revision: number | null; digest: string }>;
  part(accessToken: string, id: string, index: number, data: string): Promise<void>;
  finish(accessToken: string, id: string): Promise<UploadReceipt>;
  list(accessToken: string, offset: number): Promise<CloudRecordSummary[]>;
  read(accessToken: string, id: string): Promise<CloudExamRecord>;
}

export class SupabaseRecords implements CloudRecords {
  private config: { url: string; key: string };
  constructor(config: { url: string; key: string }) {
    this.config = config;
  }
  private client(accessToken: string) {
    return createClient(this.config.url, this.config.key, {
      accessToken: async () => accessToken,
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(12000) }),
      },
    });
  }
  private fail(error: { code?: string } | null) {
    if (!error) return;
    if (error.code === 'M0001')
      throw new DomainError(
        'The cloud copy has a different revision or examination Host. Neither copy has been overwritten.',
        409,
        'SYNC_CONFLICT',
      );
    if (error.code === 'PGRST202' || error.code === '42P01')
      throw new DomainError(
        'Cloud storage needs its database setup. Ask the platform administrator to apply the cloud migration.',
        503,
        'CLOUD_SETUP_REQUIRED',
      );
    if (error.code === '42501' || error.code === 'PGRST301')
      throw new DomainError(
        'Sign in to your cloud account again to continue syncing.',
        401,
        'UNAUTHENTICATED',
      );
    throw new DomainError(
      'Could not reach cloud storage. Your local records are safe; synchronization will retry.',
      503,
      'CLOUD_UNAVAILABLE',
    );
  }
  async ready(accessToken: string) {
    const { data, error } = await this.client(accessToken).rpc('mudu_cloud_version');
    this.fail(error);
    if (data !== 1)
      throw new DomainError(
        'Cloud storage requires a compatible database migration.',
        503,
        'CLOUD_SETUP_REQUIRED',
      );
  }
  async begin(accessToken: string, m: UploadManifest) {
    const { data, error } = await this.client(accessToken).rpc('mudu_begin_exam_upload', {
      p_upload_id: m.id,
      p_record_id: m.recordId,
      p_sitting_id: m.sittingId,
      p_host_id: m.hostId,
      p_expected_revision: m.expectedRevision,
      p_digest: m.digest,
      p_byte_length: m.byteLength,
      p_part_count: m.parts,
    });
    this.fail(error);
    return data as { received: number[]; revision: number | null; digest: string };
  }
  async part(accessToken: string, id: string, index: number, data: string) {
    const result = await this.client(accessToken).rpc('mudu_put_exam_part', {
      p_upload_id: id,
      p_index: index,
      p_data: data,
    });
    this.fail(result.error);
    if (result.data?.index !== index)
      throw new DomainError(
        'Cloud storage returned an invalid acknowledgment.',
        503,
        'CLOUD_UNAVAILABLE',
      );
  }
  async finish(accessToken: string, id: string) {
    const { data, error } = await this.client(accessToken).rpc('mudu_finish_exam_upload', {
      p_upload_id: id,
    });
    this.fail(error);
    return data as UploadReceipt;
  }
  async list(accessToken: string, offset: number) {
    await this.ready(accessToken);
    const { data, error } = await this.client(accessToken)
      .from('mudu_exam_records')
      .select('record_id,revision,synced_at,title,course,candidate_count')
      .order('synced_at', { ascending: false })
      .order('record_id', { ascending: true })
      .range(offset, offset + 19);
    this.fail(error);
    return (data ?? []).map((r) => ({
      id: r.record_id,
      title: r.title,
      course: r.course,
      candidateCount: r.candidate_count,
      revision: Number(r.revision),
      syncedAt: r.synced_at,
    })) as CloudRecordSummary[];
  }
  async read(accessToken: string, id: string) {
    const { data, error } = await this.client(accessToken)
      .from('mudu_exam_records')
      .select('payload')
      .eq('record_id', id)
      .maybeSingle();
    this.fail(error);
    if (!data) throw new DomainError('Cloud record not found.', 404);
    const document = data.payload;
    if (
      !document ||
      document.version !== 1 ||
      document.assessment?.id !== id ||
      typeof document.assessment?.title !== 'string' ||
      !Array.isArray(document.candidates) ||
      document.candidates.length > 500 ||
      document.candidates.some(
        (candidate: CloudExamRecord['candidates'][number]) =>
          !candidate ||
          typeof candidate.id !== 'string' ||
          typeof candidate.name !== 'string' ||
          typeof candidate.identifier !== 'string' ||
          typeof candidate.status !== 'string' ||
          (candidate.grade &&
            (!Number.isFinite(candidate.grade.totalScore) ||
              (candidate.grade.percentage !== null &&
                !Number.isFinite(candidate.grade.percentage)) ||
              !Number.isInteger(candidate.grade.pendingManual))),
      )
    )
      throw new DomainError(
        'This cloud record has an unsupported format. Your local records are unchanged.',
        409,
        'CLOUD_RECORD_INVALID',
      );
    return data.payload as CloudExamRecord;
  }
}

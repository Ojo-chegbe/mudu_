import type { RosterEntry, RosterSummary } from './rosters.ts';

export interface CloudRosterDocument {
  version: 1;
  id: string;
  name: string;
  description: string;
  token: string;
  restricted: boolean;
  open: boolean;
  archived: boolean;
  entries: RosterEntry[];
  members: Array<{
    id: string;
    name: string;
    email: string;
    identifier: string;
    status: 'pending' | 'approved' | 'rejected';
    requestedAt: number;
    reviewedAt: number | null;
  }>;
  invitations: Array<{
    id: string;
    email: string;
    name: string;
    identifier: string;
    token: string;
    createdAt: number;
  }>;
}
export interface CloudRosterReceipt {
  id: string;
  revision: number;
  digest: string;
  updatedAt?: number;
}
export interface CloudRosterRecord extends CloudRosterReceipt {
  payload: string;
}
export interface CloudCandidateGroup {
  id: string;
  ownerId: string;
  name: string;
  token: string;
  open: boolean;
  restricted: boolean;
  archived: boolean;
  revision: number;
  member: CloudRosterDocument['members'][number];
}
export type RosterCloudState =
  | 'local'
  | 'pending'
  | 'synced'
  | 'offline'
  | 'conflict'
  | 'setup'
  | 'paused'
  | 'signin'
  | 'connection'
  | 'blocked';
export interface RosterCloudStatus {
  id: string;
  state: RosterCloudState;
  message?: string;
  connections?: number;
  revision?: number;
  recoveryAvailable?: boolean;
}
export interface RosterCloudOverview {
  enabled: boolean;
  rosters: RosterCloudStatus[];
  state?: RosterCloudState;
  message?: string;
}
export interface SyncedRosterSummary extends RosterSummary {
  cloud?: RosterCloudStatus;
}

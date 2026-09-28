export interface RosterEntry {
  identifier: string;
  name: string;
}
export interface RosterSummary {
  id: string;
  name: string;
  revision: number;
  archived: number;
  is_open: number;
  restricted: number;
  updated_at: number;
  approved: number;
  pending: number;
  listed: number;
}
export interface RosterDetail extends RosterSummary {
  invitations: Array<{
    id: string;
    email: string;
    name: string;
    identifier: string;
    token: string;
  }>;
  token: string;
  entries: RosterEntry[];
  members: Array<{
    accountId: string;
    name: string;
    email: string;
    identifier: string;
    identityStatus: string;
    status: string;
  }>;
}
export interface RosterInvitation {
  name: string;
  accepting: boolean;
  restricted: boolean;
  status: string | null;
}

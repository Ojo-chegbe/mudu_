import type { RosterDetail } from '../../packages/contracts/rosters.ts';

export const membershipFilters = [
  ['all', 'All'],
  ['pending', 'Awaiting approval'],
  ['approved', 'Members'],
  ['rejected', 'Not admitted'],
] as const;
export type MembershipFilter = (typeof membershipFilters)[number][0];

export function filterMembers(
  members: RosterDetail['members'],
  filter: MembershipFilter,
  search: string,
) {
  const query = search.trim().toLowerCase();
  const rank = (status: string) => (status === 'pending' ? 0 : status === 'approved' ? 1 : 2);
  return members
    .filter(
      (m) =>
        (filter === 'all' || m.status === filter) &&
        `${m.name} ${m.email} ${m.identifier}`.toLowerCase().includes(query),
    )
    .sort(
      (a, b) =>
        rank(a.status) - rank(b.status) ||
        a.name.localeCompare(b.name) ||
        a.accountId.localeCompare(b.accountId),
    );
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterMembers } from '../apps/web/roster-members.ts';

test('membership filters combine status and trimmed name/email/ID search, with pending first', () => {
  const members = [
    {
      accountId: 'a',
      name: 'Anna',
      email: 'anna@example.test',
      identifier: '001',
      status: 'approved',
      identityStatus: 'verified',
    },
    {
      accountId: 'b',
      name: 'Zoe',
      email: 'zoe@example.test',
      identifier: '002',
      status: 'pending',
      identityStatus: 'pending',
    },
    {
      accountId: 'c',
      name: 'Ben',
      email: 'ben@example.test',
      identifier: '003',
      status: 'rejected',
      identityStatus: 'pending',
    },
  ];
  assert.deepEqual(
    filterMembers(members, 'all', '').map((m) => m.accountId),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(
    members.map((m) => m.accountId),
    ['a', 'b', 'c'],
  );
  assert.equal(filterMembers(members, 'pending', ' ZOE@EXAMPLE.TEST ')[0].accountId, 'b');
  assert.equal(filterMembers(members, 'approved', '001')[0].accountId, 'a');
  assert.equal(filterMembers(members, 'rejected', 'ben')[0].accountId, 'c');
  assert.equal(filterMembers(members, 'approved', 'zoe').length, 0);
  assert.equal(filterMembers([], 'all', '').length, 0);
});

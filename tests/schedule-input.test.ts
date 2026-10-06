import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleDay,
  scheduleParts,
  scheduleTimestamp,
  scheduleLabel,
} from '../apps/web/schedule-input.ts';

test('schedule fields round-trip local dates without shifting to UTC', () => {
  const value = new Date(2026, 9, 4, 9, 30).getTime();
  assert.deepEqual(scheduleParts(value), { date: '2026-10-04', time: '09:30' });
  assert.equal(scheduleTimestamp('2026-10-04', '09:30'), value);
  assert.ok(scheduleLabel(value).length > 0);
});

test('incomplete and impossible schedule entries cannot silently become a different date', () => {
  for (const [date, time] of [
    ['', '09:00'],
    ['2026-10-04', ''],
    ['2026-02-30', '09:00'],
    ['2026-10-04', '24:00'],
    ['2026-10-04', '12:60'],
    ['garbage', '09:00'],
  ]) {
    assert.equal(scheduleTimestamp(date, time), null);
  }
  assert.deepEqual(scheduleParts(null), { date: '', time: '' });
  assert.deepEqual(scheduleParts(NaN), { date: '', time: '' });
  assert.deepEqual(scheduleParts(Number.MAX_SAFE_INTEGER), { date: '', time: '' });
});

test('Today and Tomorrow follow local calendar boundaries, including month and year rollover', () => {
  const now = new Date(2026, 11, 31, 23, 30).getTime();
  assert.equal(scheduleDay(0, now), '2026-12-31');
  assert.equal(scheduleDay(1, now), '2027-01-01');
});

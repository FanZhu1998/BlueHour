import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageLabel, formatDay, formatTime, gapLabel, utcDate } from '../src/lib/format';

test('observation captions retain UTC across the local midnight boundary', () => {
  const stamp = '2026-09-27T00:03:42.000Z';
  assert.equal(formatDay(stamp), 'Sep 27, 2026');
  assert.equal(formatTime(stamp, true), '00:03:42');
  assert.equal(utcDate(stamp), '2026-09-27');
  assert.equal(utcDate('2026-09-26T20:03:42-04:00'), '2026-09-27');
});

test('recorded loops and missing time are explicitly identified', () => {
  assert.match(gapLabel('2026-09-27T12:00:00Z', '2026-09-27T10:00:00Z'), /Loop/);
  assert.match(gapLabel('2026-09-27T10:00:00Z', '2026-09-27T12:15:00Z'), /2h 15m/);
  assert.equal(ageLabel('invalid'), 'Age unavailable');
  assert.equal(
    ageLabel('2026-09-27T12:00:00Z', Date.parse('2026-09-27T10:00:00Z')),
    'Age unavailable',
  );
});

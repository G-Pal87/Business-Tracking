// Unit tests for js/core/ical.js parsing and merge safety — synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseICal, parseICalDate, isCompleteICal, mergeBlocks, mergeBlocksChecked } from '../../js/core/ical.js';

const cal = body => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}END:VCALENDAR\r\n`;
const ev = (uid, s, e, extra = '') =>
  `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${s}\r\nDTEND;VALUE=DATE:${e}\r\nSUMMARY:Reserved\r\nUID:${uid}\r\n${extra}END:VEVENT\r\n`;

test('parses basic events', () => {
  const out = parseICal(cal(ev('a1', '20260301', '20260305')));
  assert.deepEqual(out, [{ start: '2026-03-01', end: '2026-03-05', summary: 'Reserved', uid: 'a1' }]);
});

test('tolerates lowercase names, trailing spaces and folded lines', () => {
  const body = 'begin:vcalendar\nbegin:vevent  \ndtstart;value=date:20260301 \ndtend:20260303\nsummary:Airbnb (Not\n  available)\nuid:x\nend:vevent\nend:vcalendar\n';
  const [e] = parseICal(body);
  assert.equal(e.start, '2026-03-01');
  assert.equal(e.end, '2026-03-03');
  assert.equal(e.summary, 'Airbnb (Not available)');
});

test('ignores VALARM properties and unescapes TEXT', () => {
  const alarm = 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\n';
  const body = cal(`BEGIN:VEVENT\r\nDTSTART:20260301\r\nDTEND:20260302\r\nDESCRIPTION:Line one\\nA\\, B\\; C\\\\\r\n${alarm}UID:u\r\nEND:VEVENT\r\n`);
  const [e] = parseICal(body);
  assert.equal(e.description, 'Line one\nA, B; C\\');
});

test('quoted parameter with a colon does not break the value', () => {
  const body = cal('BEGIN:VEVENT\r\nDTSTART;X-NOTE="a:b":20260301\r\nDTEND:20260302\r\nUID:q\r\nEND:VEVENT\r\n');
  assert.equal(parseICal(body)[0].start, '2026-03-01');
});

test('skips events with unparseable dates', () => {
  const out = parseICal(cal(ev('bad', '20260301', 'TBD') + ev('bad2', '20261345', '20261401') + ev('ok', '20260310', '20260312')));
  assert.deepEqual(out.map(e => e.uid), ['ok']);
});

test('parseICalDate', () => {
  assert.equal(parseICalDate('20260301'), '2026-03-01');
  assert.equal(parseICalDate('20260301T150000'), '2026-03-01');
  assert.equal(parseICalDate(' 20260301t150000 '), '2026-03-01');
  assert.equal(parseICalDate('TBD'), null);
  assert.equal(parseICalDate('20260230'), null);
  assert.equal(parseICalDate('20260301T250000'), null);
  assert.equal(parseICalDate(''), null);
});

test('isCompleteICal requires END:VCALENDAR', () => {
  assert.equal(isCompleteICal(cal(ev('a', '20260301', '20260302'))), true);
  assert.equal(isCompleteICal('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:2026'), false);
  assert.equal(isCompleteICal('<html>error</html>'), false);
  assert.equal(isCompleteICal(null), false);
});

const blk = (uid, start, end) => ({ uid, start, end, summary: 'Reserved' });
const TODAY = '2026-06-01';

test('mergeBlocks keeps elapsed blocks and defers future ones to the feed', () => {
  const existing = [blk('p', '2026-05-01', '2026-05-03'), blk('f', '2026-07-01', '2026-07-03')];
  const fresh = [blk('f2', '2026-07-10', '2026-07-12')];
  assert.deepEqual(mergeBlocks(existing, fresh, TODAY).map(b => b.uid), ['p', 'f2']);
});

test('mergeBlocks refuses an empty feed when future blocks are stored', () => {
  const existing = [blk('f', '2026-07-01', '2026-07-03')];
  const r = mergeBlocksChecked(existing, [], TODAY);
  assert.equal(r.blocks, existing);
  assert.ok(r.refused);
});

test('mergeBlocks refuses a sharp drop in future blocks unless allowed', () => {
  const existing = [1, 2, 3, 4, 5, 6].map(i => blk(`f${i}`, `2026-07-0${i}`, `2026-07-0${i + 1}`));
  const fresh = existing.slice(0, 2);
  const r = mergeBlocksChecked(existing, fresh, TODAY);
  assert.equal(r.blocks, existing);
  assert.match(r.refused, /2 upcoming/);
  const forced = mergeBlocksChecked(existing, fresh, TODAY, { allowSharpDrop: true });
  assert.equal(forced.refused, null);
  assert.equal(forced.blocks.length, 2);
  // Half or more is accepted (ordinary cancellations).
  assert.equal(mergeBlocksChecked(existing, existing.slice(0, 3), TODAY).refused, null);
  // Fewer than 3 stored: no drop check.
  assert.equal(mergeBlocksChecked(existing.slice(0, 2), existing.slice(0, 0).concat([blk('n', '2026-08-01', '2026-08-02')]), TODAY).refused, null);
});

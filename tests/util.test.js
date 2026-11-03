import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtBytes, fmtMB, fmtSpeed, clamp, esc, dateGroup, autoTitle, estTokens } from '../web/js/util.js';

test('fmtBytes renders human sizes', () => {
  assert.match(fmtBytes(0), /0/);
  assert.match(fmtBytes(1048576), /1\.0/);
  assert.match(fmtBytes(532517120), /507|508/);
});

test('fmtMB returns one decimal megabytes', () => {
  assert.equal(fmtMB(1048576), '1.0');
  assert.equal(fmtMB(98336520), '93.8');
});

test('fmtSpeed switches KB/s and MB/s', () => {
  assert.match(fmtSpeed(512 * 1024), /KB\/s/);
  assert.match(fmtSpeed(3 * 1048576), /MB\/s/);
});

test('clamp bounds values', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});

test('esc neutralizes HTML', () => {
  assert.equal(esc('<script>'), '&lt;script&gt;');
  assert.equal(esc('a & b'), 'a &amp; b');
});

test('dateGroup buckets threads', () => {
  const now = Date.now();
  assert.equal(dateGroup(now), 'Today');
  assert.equal(dateGroup(now - 86400000), 'Yesterday');
  assert.equal(dateGroup(now - 3 * 86400000), 'Previous 7 Days');
  assert.equal(dateGroup(now - 30 * 86400000), 'Older');
});

test('autoTitle truncates and falls back', () => {
  assert.equal(autoTitle(''), 'New chat');
  assert.equal(autoTitle('Hello world'), 'Hello world');
  const long = 'x'.repeat(80);
  assert.ok(autoTitle(long).length <= 43);
  assert.ok(autoTitle(long).endsWith('…'));
});

test('estTokens is monotonic', () => {
  assert.ok(estTokens('abcd') > 0);
  assert.ok(estTokens('a'.repeat(100)) > estTokens('a'.repeat(10)));
});

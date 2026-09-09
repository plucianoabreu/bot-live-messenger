import test from 'node:test';
import assert from 'node:assert/strict';
import { isHermesTestUserAllowed, permitsHermesAdmission } from '../src/server/execution/hermes-test-scope';

const testUser = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherUser = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('Hermes test scope permits all users when no scope is configured', () => {
  assert.equal(isHermesTestUserAllowed({}, otherUser), true);
});

test('Hermes test scope permits only its configured account', () => {
  assert.equal(isHermesTestUserAllowed({ HERMES_TEST_USER_ID: testUser }, testUser), true);
  assert.equal(isHermesTestUserAllowed({ HERMES_TEST_USER_ID: testUser }, otherUser), false);
});

test('Hermes test scope fails closed for malformed configured account IDs', () => {
  assert.equal(isHermesTestUserAllowed({ HERMES_TEST_USER_ID: 'not-a-uuid' }, testUser), false);
});

test('Hermes test scope blocks only non-test admission while Hermes or prewarm is active', () => {
  const scope = { HERMES_TEST_USER_ID: testUser };
  assert.equal(permitsHermesAdmission(scope, otherUser), true);
  assert.equal(permitsHermesAdmission({ ...scope, HERMES_ENABLED: 'true' }, otherUser), false);
  assert.equal(permitsHermesAdmission({ ...scope, PREWARM_ENABLED: 'true' }, otherUser), false);
  assert.equal(permitsHermesAdmission({ ...scope, HERMES_ENABLED: 'true' }, testUser), true);
});

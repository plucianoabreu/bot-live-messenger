import test from 'node:test';
import assert from 'node:assert/strict';
import { isHermesTestUserAllowed } from '../src/server/execution/hermes-test-scope';

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

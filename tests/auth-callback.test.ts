import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredAppOrigin, planAuthCallback } from '../src/server/auth/callback';

test('a callback without a code redirects to a controlled sign-in error without requiring APP_URL', () => {
  assert.deepEqual(planAuthCallback('https://www.botlivemessenger.com/auth/callback?flow=recovery'), {
    kind: 'signin_error',
    redirectUrl: 'https://www.botlivemessenger.com/?error=signin',
  });
});

test('a callback with a code fails closed when APP_URL is missing or invalid', () => {
  assert.deepEqual(planAuthCallback('https://www.botlivemessenger.com/auth/callback?code=opaque'), {
    kind: 'configuration_error',
  });
  assert.deepEqual(planAuthCallback('https://www.botlivemessenger.com/auth/callback?code=opaque', 'not-a-url'), {
    kind: 'configuration_error',
  });
});

test('a configured recovery callback exchanges the code and redirects to reset password', () => {
  assert.deepEqual(
    planAuthCallback(
      'https://www.botlivemessenger.com/auth/callback?code=opaque&flow=recovery',
      'https://www.botlivemessenger.com',
    ),
    {
      kind: 'exchange',
      code: 'opaque',
      successRedirectUrl: 'https://www.botlivemessenger.com/reset-password',
      failureRedirectUrl: 'https://www.botlivemessenger.com/?error=signin',
    },
  );
});

test('a configured non-recovery callback redirects a successful exchange to Messenger', () => {
  const result = planAuthCallback(
    'https://deployment.example/auth/callback?code=opaque',
    'https://www.botlivemessenger.com/',
  );
  assert.equal(result.kind, 'exchange');
  if (result.kind === 'exchange') assert.equal(result.successRedirectUrl, 'https://www.botlivemessenger.com/messenger');
});

test('APP_URL validation accepts only a clean HTTP origin', () => {
  assert.equal(configuredAppOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(configuredAppOrigin('https://www.botlivemessenger.com/'), 'https://www.botlivemessenger.com');
  assert.equal(configuredAppOrigin('https://user:pass@example.com'), null);
  assert.equal(configuredAppOrigin('https://example.com/path'), null);
  assert.equal(configuredAppOrigin('https://example.com?next=other'), null);
});

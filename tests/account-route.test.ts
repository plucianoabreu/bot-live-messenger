import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_DELETION_CONFIRMATION } from '../src/domain/account-deletion';
import { AccountDeletionError, requestAccountDeletion } from '../src/server/account-deletion';
import { createAccountDeletionHandlers, type AccountDeletionRouteDependencies } from '../src/server/account-deletion-route';

function dependencies(overrides: Partial<AccountDeletionRouteDependencies> = {}) {
  const calls: string[] = [];
  const db = {
    auth: {
      signInWithPassword: async () => { calls.push('reauth'); return { data: { user: { id: 'user-a' } }, error: null }; },
      signOut: async () => { calls.push('signout'); return { error: null }; },
    },
    rpc: async () => ({ data: null, error: null }),
  };
  const base = {
    readiness: () => ({ ready: true, reasons: [] }),
    authenticate: async () => ({ db, user: { id: 'user-a', email: 'owner@example.com' } }),
    readJson: async (request: Request) => request.json(),
    originAllowed: (request: Request) => request.headers.get('origin') === new URL(request.url).origin,
    requestDeletion: requestAccountDeletion,
    persist: async () => { calls.push('persist'); return { id: crypto.randomUUID(), state: 'PENDING', requested_at: new Date().toISOString() }; },
    ...overrides,
  } as unknown as AccountDeletionRouteDependencies;
  return { calls, handlers: createAccountDeletionHandlers(base) };
}

function request(body: string, origin = 'http://app.test') {
  return new Request('http://app.test/api/account/deletion', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body });
}

test('account deletion route rejects cross-origin, disabled and invalid requests before persistence', async () => {
  const crossOrigin = dependencies();
  assert.equal((await crossOrigin.handlers.POST(request('{}', 'https://evil.example'))).status, 403);
  assert.deepEqual(crossOrigin.calls, []);

  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const disabled = dependencies({ readiness: (() => ({ ready: false, reasons: ['ACCOUNT_CLEANUP_DISABLED'] })) as AccountDeletionRouteDependencies['readiness'] });
    assert.equal((await disabled.handlers.POST(request('{}'))).status, 503);
    assert.deepEqual(errors, [['ACCOUNT_CLEANUP_UNAVAILABLE', 'ACCOUNT_CLEANUP_DISABLED']]);
  } finally {
    console.error = originalError;
  }

  const invalid = dependencies();
  assert.equal((await invalid.handlers.POST(request(JSON.stringify({ password: 'secret1', confirmation: 'delete' })))).status, 400);
  assert.deepEqual(invalid.calls, []);

  const oversized = dependencies({ readJson: async () => { throw new Error('BODY_TOO_LARGE'); } });
  assert.equal((await oversized.handlers.POST(request(JSON.stringify({ password: 'x'.repeat(1100), confirmation: ACCOUNT_DELETION_CONFIRMATION })))).status, 413);
  assert.deepEqual(oversized.calls, []);
});

test('account deletion route reauthenticates, persists and globally signs out on success', async () => {
  const { calls, handlers } = dependencies();
  const response = await handlers.POST(request(JSON.stringify({ password: 'secret1', confirmation: ACCOUNT_DELETION_CONFIRMATION })));
  assert.equal(response.status, 202);
  assert.deepEqual(calls, ['reauth', 'persist', 'signout']);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('account deletion route fails closed when live bucket verification rejects cleanup', async () => {
  const { calls, handlers } = dependencies({
    persist: async () => { calls.push('persist'); throw new AccountDeletionError('CLEANUP_UNAVAILABLE'); },
  });
  const response = await handlers.POST(request(JSON.stringify({ password: 'secret1', confirmation: ACCOUNT_DELETION_CONFIRMATION })));
  assert.equal(response.status, 503);
  assert.deepEqual(calls, ['reauth', 'persist']);
});

test('account deletion status route preserves authentication and private caching boundaries', async () => {
  const unauthenticated = dependencies({ authenticate: async () => ({ response: Response.json({ error: 'login' }, { status: 401 }) }) });
  assert.equal((await unauthenticated.handlers.GET()).status, 401);
  const authenticated = dependencies({ authenticate: async () => ({
    db: { auth: { signInWithPassword: async () => ({ data: { user: null }, error: null }), signOut: async () => ({ error: null }) },
      rpc: async () => ({ data: { id: crypto.randomUUID(), state: 'PENDING' }, error: null }) },
    user: { id: 'user-a', email: 'owner@example.com' },
  }) as never });
  const response = await authenticated.handlers.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await response.json()).deletion.state, 'PENDING');
});

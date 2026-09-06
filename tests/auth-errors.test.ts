import test from 'node:test';
import assert from 'node:assert/strict';
import { signupErrorResponse } from '../src/domain/auth-errors';

test('email delivery rate limits tell the user to wait instead of blaming their data', () => {
  assert.deepEqual(signupErrorResponse({ code: 'over_email_send_rate_limit', status: 429 }), {
    status: 429,
    message: 'Muitos e-mails de confirmação foram solicitados. Aguarde até 1 hora e tente novamente.',
  });
});

test('invalid signup data keeps a useful generic message', () => {
  assert.deepEqual(signupErrorResponse({ code: 'user_already_exists', status: 422 }), {
    status: 400,
    message: 'Não foi possível criar a conta. Confira os dados ou tente entrar.',
  });
});

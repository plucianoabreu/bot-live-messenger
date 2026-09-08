type AuthErrorLike = { code?: string; status?: number };

export function loginErrorResponse(error: AuthErrorLike) {
  if (error.code === 'email_not_confirmed') {
    return {
      status: 403,
      message: 'Confirme seu e-mail para entrar. Abra o link que enviamos e confira também a pasta de spam.',
    };
  }
  return {
    status: 401,
    message: 'O e-mail ou a senha não conferem.',
  };
}

export function signupErrorResponse(error: AuthErrorLike) {
  if (error.code === 'over_email_send_rate_limit') {
    return {
      status: 429,
      message: 'Muitos e-mails de confirmação foram solicitados. Aguarde até 1 hora e tente novamente.',
    };
  }
  return {
    status: 400,
    message: 'Não foi possível criar a conta. Confira os dados ou tente entrar.',
  };
}

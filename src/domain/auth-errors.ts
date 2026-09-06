type AuthErrorLike = { code?: string; status?: number };

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

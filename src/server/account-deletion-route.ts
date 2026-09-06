import { accountDeletionInput } from '@/domain/account-deletion';
import { AccountDeletionError, type requestAccountDeletion } from '@/server/account-deletion';

const headers = { 'Cache-Control': 'private, no-store' };

export type AccountDeletionRouteDependencies = {
  readiness(): { ready: boolean };
  authenticate(): Promise<{ response: Response } | { response?: undefined; db: Parameters<typeof requestAccountDeletion>[0]['db'] & { rpc(name: string): PromiseLike<{ data: unknown; error: unknown }> }; user: { id: string; email?: string | null } }>;
  readJson(request: Request, maxBytes: number): Promise<unknown>;
  originAllowed(request: Request): boolean;
  requestDeletion: typeof requestAccountDeletion;
  persist(userId: string): Promise<unknown>;
};

export function createAccountDeletionHandlers(dependencies: AccountDeletionRouteDependencies) {
  async function get() {
    const auth = await dependencies.authenticate();
    if (auth.response) return auth.response;
    const result = await auth.db.rpc('get_account_deletion_request');
    if (result.error) return Response.json({ error: 'Não foi possível consultar o pedido.' }, { status: 500, headers });
    return Response.json({ deletion: result.data ?? null }, { headers });
  }

  async function post(request: Request) {
    if (!dependencies.originAllowed(request)) return Response.json({ error: 'Origem inválida.' }, { status: 403, headers });
    if (!dependencies.readiness().ready) return Response.json({ error: 'A exclusão de conta ainda não está disponível.' }, { status: 503, headers });
    const auth = await dependencies.authenticate();
    if (auth.response) return auth.response;
    let body: unknown;
    try { body = await dependencies.readJson(request, 1024); }
    catch (error) { return Response.json({ error: 'Dados inválidos.' }, { status: error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 400, headers }); }
    const parsed = accountDeletionInput.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Confirme a exclusão e informe sua senha atual.' }, { status: 400, headers });
    try {
      const deletion = await dependencies.requestDeletion({ db: auth.db, currentUser: auth.user,
        password: parsed.data.password, persist: dependencies.persist });
      return Response.json({ deletion,
        message: 'Pedido registrado. A limpeza ainda está pendente e será processada com novas tentativas em caso de falha.' },
      { status: 202, headers });
    } catch (error) {
      if (error instanceof AccountDeletionError && error.code === 'REAUTHENTICATION_FAILED') {
        return Response.json({ error: 'A senha não confere.' }, { status: 401, headers });
      }
      if (error instanceof AccountDeletionError && error.code === 'ACCOUNT_MISMATCH') {
        return Response.json({ error: 'Não foi possível confirmar a conta.' }, { status: 403, headers });
      }
      if (error instanceof AccountDeletionError && error.code === 'CLEANUP_UNAVAILABLE') {
        return Response.json({ error: 'A exclusão de conta ainda não está disponível.' }, { status: 503, headers });
      }
      return Response.json({ error: 'Não foi possível registrar a exclusão com segurança.' }, { status: 500, headers });
    }
  }
  return { GET: get, POST: post };
}

import { z } from 'zod';
import { requireUser, sameOrigin } from '@/server/http';
import { requireComputerConfiguration } from '@/server/computer/config';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return Response.json({ error: 'Origem inválida.' }, { status: 403 });
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: 'Tarefa inválida.' }, { status: 400 });
  if (!requireComputerConfiguration().available) {
    return Response.json({ error: 'O computador ainda não está disponível.' }, { status: 503 });
  }
  const { data, error } = await auth.db.rpc('start_watch', { p_run_id: id });
  if (error) {
    const unavailable = error.message.includes('INTEGRATION_UNAVAILABLE');
    return Response.json(
      { error: unavailable ? 'O computador ainda não está disponível.' : 'A tarefa não está disponível para acompanhamento.' },
      { status: unavailable ? 503 : 404 },
    );
  }
  return Response.json({ leaseId: data, expiresInSeconds: 60 }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}

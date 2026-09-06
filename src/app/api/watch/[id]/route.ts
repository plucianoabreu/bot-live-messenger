import { z } from 'zod';
import { requireUser, sameOrigin } from '@/server/http';
import { requireComputerConfiguration } from '@/server/computer/config';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return Response.json({ error: 'Origem inválida.' }, { status: 403 });
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: 'Acompanhamento inválido.' }, { status: 400 });
  if (!requireComputerConfiguration().available) {
    return Response.json({ error: 'O computador ainda não está disponível.' }, { status: 503 });
  }
  const { data, error } = await auth.db.rpc('renew_watch', { p_watch_id: id });
  if (error) {
    const unavailable = error.message.includes('INTEGRATION_UNAVAILABLE');
    return Response.json(
      { error: unavailable ? 'O computador ainda não está disponível.' : 'O acompanhamento expirou.' },
      { status: unavailable ? 503 : 404 },
    );
  }
  return Response.json({ leaseId: id, expiresAt: data }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return Response.json({ error: 'Origem inválida.' }, { status: 403 });
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: 'Acompanhamento inválido.' }, { status: 400 });
  const { error } = await auth.db.rpc('stop_watch', { p_watch_id: id });
  if (error) return Response.json({ error: 'Acompanhamento não encontrado.' }, { status: 404 });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

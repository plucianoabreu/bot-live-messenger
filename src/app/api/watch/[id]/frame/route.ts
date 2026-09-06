import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireUser } from '@/server/http';
import { requireComputerConfiguration } from '@/server/computer/config';
import { workerDatabase } from '@/server/execution/database';
import { verifyPrivateStorageBucket } from '@/server/computer/database';

type FrameAuthorization = {
  slot: number;
  captured_at: string;
  content_type: 'image/png' | 'image/jpeg';
  size_bytes: number;
  checksum_sha256: string;
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: 'Acompanhamento inválido.' }, { status: 400 });
  if (!requireComputerConfiguration().available) {
    return Response.json({ error: 'O computador ainda não está disponível.' }, { status: 503 });
  }
  const { data, error } = await auth.db.rpc('authorize_watch_frame', { p_watch_id: id });
  if (error || !data) return Response.json({ error: 'Imagem indisponível ou expirada.' }, { status: 404 });
  const authorization = data as FrameAuthorization;
  try {
    const service = workerDatabase();
    const { data: frame, error: frameError } = await service.from('watch_frames').select('object_path')
      .eq('lease_id', id).eq('user_id', auth.user.id).eq('slot', authorization.slot).maybeSingle();
    if (frameError || !frame) return Response.json({ error: 'Imagem indisponível ou expirada.' }, { status: 404 });
    const bucket = await verifyPrivateStorageBucket(process.env.WATCH_FRAME_BUCKET, service);
    const { data: object, error: objectError } = await service.storage.from(bucket).download(frame.object_path);
    if (objectError || !object) return Response.json({ error: 'Imagem indisponível.' }, { status: 404 });
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== authorization.size_bytes || createHash('sha256').update(bytes).digest('hex') !== authorization.checksum_sha256) {
      return Response.json({ error: 'Imagem indisponível.' }, { status: 409 });
    }
    return new Response(object, { headers: {
      'Content-Type': authorization.content_type,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Captured-At': authorization.captured_at,
      'Content-Security-Policy': "default-src 'none'; sandbox",
    } });
  } catch {
    return Response.json({ error: 'O acompanhamento ainda não está disponível.' }, { status: 503 });
  }
}

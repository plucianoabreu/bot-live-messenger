import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireUser } from '@/server/http';
import { attachmentHeaders } from '@/server/computer/artifacts';
import { workerDatabase } from '@/server/execution/database';
import { verifyPrivateStorageBucket } from '@/server/computer/database';

type ArtifactRow = {
  id: string;
  user_id: string;
  run_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  checksum_sha256: string;
  delivered_at: string;
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: 'Arquivo inválido.' }, { status: 400 });
  const { data, error } = await auth.db.from('artifacts')
    .select('id,user_id,run_id,name,mime_type,size_bytes,checksum_sha256,delivered_at')
    .eq('id', id).not('delivered_at', 'is', null).maybeSingle();
  if (error || !data) return Response.json({ error: 'Arquivo não encontrado.' }, { status: 404 });
  const artifact = data as ArtifactRow;
  try {
    const service = workerDatabase();
    const { data: privateRow, error: privateError } = await service.from('artifacts').select('object_path')
      .eq('id', id).eq('user_id', auth.user.id).eq('run_id', artifact.run_id).not('delivered_at', 'is', null).maybeSingle();
    if (privateError || !privateRow) return Response.json({ error: 'Arquivo não encontrado.' }, { status: 404 });
    const bucket = await verifyPrivateStorageBucket(process.env.ARTIFACT_BUCKET, service);
    const { data: object, error: objectError } = await service.storage.from(bucket).download(privateRow.object_path);
    if (objectError || !object) return Response.json({ error: 'Arquivo não encontrado.' }, { status: 404 });
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== Number(artifact.size_bytes) || createHash('sha256').update(bytes).digest('hex') !== artifact.checksum_sha256) {
      return Response.json({ error: 'Não foi possível verificar o arquivo.' }, { status: 409 });
    }
    return new Response(object, { headers: attachmentHeaders({ name: artifact.name, mimeType: artifact.mime_type }) });
  } catch {
    return Response.json({ error: 'Os downloads ainda não estão disponíveis.' }, { status: 503 });
  }
}

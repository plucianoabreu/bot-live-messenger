import 'server-only';
import { workerDatabase } from '@/server/execution/database';
import { ComputerFoundationError } from './contracts';
import type { ArtifactIntentInput, ArtifactRepository, PrivateArtifactStore } from './artifacts';
import type { ComputerOperationAuthorizer } from './session';
import { verifyPrivateStorageBucket } from './storage-policy';
import type { LeaseRequest, ResourceLease, ResourceLeaseRepository } from './resources';
import type { WatchCaptureAuthorizer } from './watch';
import type { HermesArtifactAuthorizer } from './hermes-artifacts';

type WorkerDatabase = ReturnType<typeof workerDatabase>;

export function databaseResourceLeaseRepository(db: WorkerDatabase = workerDatabase()): ResourceLeaseRepository {
  return {
    acquire: async (request: LeaseRequest, now: Date) => {
      const { data, error } = await db.rpc('acquire_computer_resource', {
        p_run_id: request.runId, p_run_version: request.executionVersion, p_holder_id: request.holderId,
        p_resource_key: request.resourceKey, p_ttl_seconds: Math.ceil(request.ttlMs / 1000),
      });
      if (error || data === null) {
        const code = error?.message.includes('RESOURCE_RECONCILIATION_REQUIRED') ? 'RESOURCE_RECONCILIATION_REQUIRED' :
          error?.message.includes('RESOURCE_BUSY') ? 'RESOURCE_BUSY' : 'LEASE_LOST';
        throw new ComputerFoundationError(code);
      }
      return { ownerId: request.ownerId, runId: request.runId, executionVersion: request.executionVersion,
        holderId: request.holderId, resourceKey: request.resourceKey, fencingToken: Number(data),
        expiresAt: new Date(now.getTime() + request.ttlMs) };
    },
    current: async (ownerId, resourceKey) => {
      const { data, error } = await db.rpc('current_computer_resource', { p_user_id: ownerId, p_resource_key: resourceKey });
      if (error || !data) return null;
      const value = data as Record<string, unknown>;
      return { ownerId: String(value.owner_id), runId: String(value.run_id), executionVersion: Number(value.execution_version),
        holderId: String(value.holder_id), resourceKey: String(value.resource_key), fencingToken: Number(value.fencing_token),
        expiresAt: new Date(String(value.expires_at)) } satisfies ResourceLease;
    },
    release: async lease => {
      const { data, error } = await db.rpc('release_computer_resource', { p_run_id: lease.runId,
        p_run_version: lease.executionVersion, p_resource_key: lease.resourceKey, p_fencing_token: lease.fencingToken });
      return !error && data === true;
    },
  };
}

export function databaseOperationAuthorizer(db: WorkerDatabase = workerDatabase()): ComputerOperationAuthorizer {
  return {
    begin: async (lease, kind) => {
    const operationId = crypto.randomUUID();
    const { data, error } = await db.rpc('authorize_computer_operation', {
      p_run_id: lease.runId,
      p_run_version: lease.executionVersion,
      p_resource_key: lease.resourceKey,
      p_fencing_token: lease.fencingToken,
      p_kind: kind,
      p_operation_id: operationId,
      p_deadline_seconds: 30,
    });
    if (error || !data) {
      const code = error?.message.includes('ACTION_LIMIT') ? 'ACTION_LIMIT' :
        error?.message.includes('RESOURCE_BUSY') ? 'RESOURCE_BUSY' : 'LEASE_LOST';
      throw new ComputerFoundationError(code);
    }
    return { id: operationId, deadline: new Date(data as string) };
    },
    finish: async (operation, outcome) => {
      const { error } = await db.rpc('finish_computer_operation', { p_operation_id: operation.id, p_outcome: outcome });
      if (error) throw new ComputerFoundationError('LEASE_LOST');
    },
  };
}

export function databaseArtifactRepository(db: WorkerDatabase = workerDatabase()): ArtifactRepository {
  return {
    reserve: async (input: ArtifactIntentInput) => {
      const { data, error } = await db.rpc('reserve_artifact_upload', {
        p_run_id: input.runId,
        p_run_version: input.executionVersion,
        p_resource_key: input.resourceKey,
        p_fencing_token: input.fencingToken,
        p_final_output_key: input.finalOutputKey,
        p_name: input.name,
        p_object_path: input.objectPath,
        p_mime_type: input.mimeType,
        p_size_bytes: input.sizeBytes,
        p_checksum_sha256: input.checksumSha256,
      });
      if (error || !data) throw new ComputerFoundationError(error?.message.includes('LEASE_LOST') ? 'LEASE_LOST' : 'ARTIFACT_INVALID');
      return { id: data as string };
    },
    markUploaded: async intentId => {
      const { error } = await db.rpc('mark_artifact_uploaded', { p_intent_id: intentId });
      if (error) throw new ComputerFoundationError('ARTIFACT_INVALID');
    },
    finalize: async intentId => {
      const { data, error } = await db.rpc('finalize_artifact_upload', { p_intent_id: intentId });
      if (error || !data) throw new ComputerFoundationError(error?.message.includes('LEASE_LOST') ? 'LEASE_LOST' : 'ARTIFACT_INVALID');
      const row = data as Record<string, unknown>;
      return { id: String(row.id), ownerId: String(row.user_id), runId: String(row.run_id), name: String(row.name),
        mimeType: String(row.mime_type), sizeBytes: Number(row.size_bytes), checksumSha256: String(row.checksum_sha256), createdAt: new Date(String(row.created_at)) };
    },
    reject: async (intentId, uploaded) => {
      const { error } = await db.rpc('reject_artifact_upload', { p_intent_id: intentId, p_uploaded: uploaded });
      if (error) throw new ComputerFoundationError('ARTIFACT_INVALID');
    },
    findOwned: async (ownerId, artifactId) => {
      const { data, error } = await db.from('artifacts').select('id,user_id,run_id,name,mime_type,size_bytes,checksum_sha256,created_at,object_path')
        .eq('id', artifactId).eq('user_id', ownerId).not('delivered_at', 'is', null).maybeSingle();
      if (error || !data || !data.checksum_sha256) return null;
      return { id: data.id, ownerId: data.user_id, runId: data.run_id, name: data.name, mimeType: data.mime_type,
        sizeBytes: Number(data.size_bytes), checksumSha256: data.checksum_sha256, createdAt: new Date(data.created_at), objectPath: data.object_path };
    },
  };
}

export function databaseHermesArtifactRepository(db: WorkerDatabase = workerDatabase()): ArtifactRepository {
  const repository = databaseArtifactRepository(db);
  return {
    ...repository,
    reserve: async (input: ArtifactIntentInput) => {
      const exportPath = input.resourceKey.startsWith('file:') ? input.resourceKey.slice('file:'.length) : '';
      const { data, error } = await db.rpc('reserve_hermes_artifact_upload', {
        p_run_id: input.runId,
        p_run_version: input.executionVersion,
        p_export_path: exportPath,
        p_final_output_key: input.finalOutputKey,
        p_name: input.name,
        p_object_path: input.objectPath,
        p_mime_type: input.mimeType,
        p_size_bytes: input.sizeBytes,
        p_checksum_sha256: input.checksumSha256,
      });
      if (error || !data) throw new ComputerFoundationError(error?.message.includes('LEASE_LOST') ? 'LEASE_LOST' : 'ARTIFACT_INVALID');
      return { id: data as string };
    },
  };
}

export function databaseHermesArtifactAuthorizer(db: WorkerDatabase = workerDatabase()): HermesArtifactAuthorizer {
  return {
    authorize: async input => {
      const { data, error } = await db.rpc('authorize_hermes_artifact_export', {
        p_user_id: input.ownerId,
        p_run_id: input.runId,
        p_run_version: input.executionVersion,
        p_export_path: input.exportPath,
      });
      if (error || !data || typeof data !== 'object' || !('machine_id' in data)) {
        throw new ComputerFoundationError('LEASE_LOST');
      }
      return { machineId: String(data.machine_id) };
    },
  };
}

export function privateArtifactStore(bucket: string, db: WorkerDatabase = workerDatabase()): PrivateArtifactStore {
  if (!bucket) throw new ComputerFoundationError('INTEGRATION_UNAVAILABLE');
  return {
    put: async (objectPath, bytes, mimeType) => {
      await verifyPrivateStorageBucket(bucket, db);
      // The key is owner/run/output-key/content-hash scoped, so an identical
      // retry may safely replace the same private object before DB finalization.
      const { error } = await db.storage.from(bucket).upload(objectPath, bytes, { contentType: mimeType, upsert: true });
      if (error) throw new ComputerFoundationError('ARTIFACT_INVALID');
    },
    get: async objectPath => {
      await verifyPrivateStorageBucket(bucket, db);
      const { data, error } = await db.storage.from(bucket).download(objectPath);
      if (error || !data) throw new ComputerFoundationError('ARTIFACT_NOT_FOUND');
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}

export { verifyPrivateStorageBucket } from './storage-policy';

export function databaseWatchCaptureAuthorizer(db: WorkerDatabase = workerDatabase()): WatchCaptureAuthorizer {
  return { authorize: async (ownerId, watchId) => {
    const { error } = await db.rpc('authorize_watch_capture', { p_user_id: ownerId, p_watch_id: watchId });
    if (error) throw new ComputerFoundationError('WATCH_EXPIRED');
  } };
}

export async function cleanupOneExpiredWatch(bucket: string, db: WorkerDatabase = workerDatabase()) {
  await verifyPrivateStorageBucket(bucket, db);
  const { data, error } = await db.rpc('claim_watch_cleanup');
  if (error) throw new ComputerFoundationError('LEASE_LOST');
  if (!data) return false;
  const claim = data as { lease_id: string; user_id: string; cleanup_token: string; object_paths: string[] };
  const prefix = `${claim.user_id}/${claim.lease_id}/`;
  if (!Array.isArray(claim.object_paths) || claim.object_paths.some(value => value !== `${prefix}0` && value !== `${prefix}1`)) {
    throw new ComputerFoundationError('UNSAFE_PATH');
  }
  if (claim.object_paths.length > 0) {
    const { error: removeError } = await db.storage.from(bucket).remove(claim.object_paths);
    if (removeError) throw new ComputerFoundationError('ARTIFACT_INVALID');
  }
  const { data: finished, error: finishError } = await db.rpc('finish_watch_cleanup', { p_cleanup_token: claim.cleanup_token });
  if (finishError || finished !== true) throw new ComputerFoundationError('LEASE_LOST');
  return true;
}

export async function putPrivateWatchFrame(
  bucket: string,
  objectPath: string,
  bytes: Uint8Array,
  contentType: 'image/png' | 'image/jpeg',
  db: WorkerDatabase = workerDatabase(),
) {
  await verifyPrivateStorageBucket(bucket, db);
  const { error } = await db.storage.from(bucket).upload(objectPath, bytes, { contentType, upsert: true });
  if (error) throw new ComputerFoundationError('ARTIFACT_INVALID');
}

export async function cleanupOneArtifactIntent(bucket: string, db: WorkerDatabase = workerDatabase()) {
  await verifyPrivateStorageBucket(bucket, db);
  const { data, error } = await db.rpc('claim_artifact_cleanup');
  if (error) throw new ComputerFoundationError('LEASE_LOST');
  if (!data) return false;
  const claim = data as { intent_id: string; user_id: string; run_id: string; cleanup_token: string; object_path: string };
  const prefix = `${claim.user_id}/${claim.run_id}/`;
  if (!claim.object_path.startsWith(prefix) || claim.object_path.includes('/../')) throw new ComputerFoundationError('UNSAFE_PATH');
  const { error: removeError } = await db.storage.from(bucket).remove([claim.object_path]);
  if (removeError) throw new ComputerFoundationError('ARTIFACT_INVALID');
  const { data: finished, error: finishError } = await db.rpc('finish_artifact_cleanup', { p_cleanup_token: claim.cleanup_token });
  if (finishError || finished !== true) throw new ComputerFoundationError('LEASE_LOST');
  return true;
}

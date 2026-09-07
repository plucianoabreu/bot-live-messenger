import { createHash } from 'node:crypto';
import path from 'node:path';
import { ComputerFoundationError, type ComputerIdentity, type ComputerProvider } from './contracts';
import { normalizeExportPath, validateExportedFile, type WorkspacePolicy } from './policy';
import { type ResourceLease, ResourceLeaseManager } from './resources';
import { FencedComputerSession, type ComputerOperationAuthorizer } from './session';

export type ArtifactMetadata = {
  id: string;
  ownerId: string;
  runId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  createdAt: Date;
};

export type ArtifactIntentInput = Omit<ArtifactMetadata, 'id' | 'createdAt'> & {
  finalOutputKey: string;
  objectPath: string;
  executionVersion: number;
  resourceKey: string;
  fencingToken: number;
};

export interface PrivateArtifactStore {
  put(objectPath: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(objectPath: string): Promise<Uint8Array>;
}

export interface ArtifactRepository {
  reserve(input: ArtifactIntentInput): Promise<{ id: string }>;
  markUploaded(intentId: string): Promise<void>;
  finalize(intentId: string): Promise<ArtifactMetadata>;
  reject(intentId: string, uploaded: boolean): Promise<void>;
  findOwned(ownerId: string, artifactId: string): Promise<(ArtifactMetadata & { objectPath: string }) | null>;
}

export type PersistExportedArtifactInput = {
  ownerId: string;
  runId: string;
  finalOutputKey: string;
  relativePath: string;
  exported: Awaited<ReturnType<ComputerProvider['readExport']>>;
  executionVersion: number;
  resourceKey: string;
  fencingToken: number;
  policy: WorkspacePolicy;
  store: PrivateArtifactStore;
  repository: ArtifactRepository;
};

function safeFileName(filePath: string) {
  const name = path.posix.basename(filePath).normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
  if (!name || name === '.' || name === '..') throw new ComputerFoundationError('ARTIFACT_INVALID');
  return name;
}

function safeMimeType(value: string) {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value)
    ? value.toLowerCase()
    : 'application/octet-stream';
}

export async function persistExportedArtifact(input: PersistExportedArtifactInput) {
  const normalizedPath = normalizeExportPath(input.relativePath, input.policy);
  if (input.resourceKey !== `file:${normalizedPath}`) throw new ComputerFoundationError('LEASE_LOST');
  const exported = validateExportedFile(input.exported, input.relativePath, input.policy);
  const checksumSha256 = createHash('sha256').update(exported.bytes).digest('hex');
  const outputKeyHash = createHash('sha256').update(input.finalOutputKey).digest('hex').slice(0, 24);
  const objectPath = `${input.ownerId}/${input.runId}/${outputKeyHash}/${checksumSha256}`;
  const mimeType = safeMimeType(exported.mimeType);
  const intentInput = {
    ownerId: input.ownerId,
    runId: input.runId,
    finalOutputKey: input.finalOutputKey,
    objectPath,
    executionVersion: input.executionVersion,
    resourceKey: input.resourceKey,
    fencingToken: input.fencingToken,
    name: safeFileName(normalizedPath),
    mimeType,
    sizeBytes: exported.bytes.byteLength,
    checksumSha256,
  };
  const intent = await input.repository.reserve(intentInput);
  // A transport error cannot prove that Storage did not persist the object.
  // Once an upload is attempted, reject into the durable cleanup queue.
  let uploadAttempted = false;
  try {
    uploadAttempted = true;
    await input.store.put(objectPath, exported.bytes, mimeType);
    await input.repository.markUploaded(intent.id);
    return await input.repository.finalize(intent.id);
  } catch (error) {
    try { await input.repository.reject(intent.id, uploadAttempted); } catch { /* the expiring intent is still reclaimable */ }
    throw error;
  }
}

export async function exportArtifact(input: {
  ownerId: string;
  runId: string;
  finalOutputKey: string;
  relativePath: string;
  computer: ComputerIdentity;
  provider: ComputerProvider;
  lease: ResourceLease;
  leases: ResourceLeaseManager;
  authorizer: ComputerOperationAuthorizer;
  policy: WorkspacePolicy;
  store: PrivateArtifactStore;
  repository: ArtifactRepository;
}) {
  const normalizedPath = normalizeExportPath(input.relativePath, input.policy);
  const session = new FencedComputerSession(input.provider, input.computer, input.lease, input.leases, input.authorizer);
  const exported = await session.readExport(normalizedPath);
  return persistExportedArtifact({
    ownerId: input.ownerId,
    runId: input.runId,
    finalOutputKey: input.finalOutputKey,
    relativePath: input.relativePath,
    exported,
    executionVersion: input.lease.executionVersion,
    resourceKey: input.lease.resourceKey,
    fencingToken: input.lease.fencingToken,
    policy: input.policy,
    store: input.store,
    repository: input.repository,
  });
}

export async function downloadArtifact(ownerId: string, artifactId: string, repository: ArtifactRepository, store: PrivateArtifactStore) {
  const artifact = await repository.findOwned(ownerId, artifactId);
  if (!artifact) throw new ComputerFoundationError('ARTIFACT_NOT_FOUND');
  const bytes = await store.get(artifact.objectPath);
  if (bytes.byteLength !== artifact.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== artifact.checksumSha256) {
    throw new ComputerFoundationError('ARTIFACT_INVALID');
  }
  return { artifact, bytes };
}

export function attachmentHeaders(artifact: Pick<ArtifactMetadata, 'name' | 'mimeType'>) {
  const fallback = artifact.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'download';
  return {
    'Content-Type': artifact.mimeType,
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
  };
}

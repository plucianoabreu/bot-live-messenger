import { ComputerFoundationError, type ExportedFile } from './contracts';
import { persistExportedArtifact, type ArtifactRepository, type PrivateArtifactStore } from './artifacts';
import { normalizeExportPath, type WorkspacePolicy } from './policy';

export type HermesArtifactAuthorization = { machineId: string };

export interface HermesArtifactAuthorizer {
  authorize(input: { ownerId: string; runId: string; executionVersion: number; exportPath: string }): Promise<HermesArtifactAuthorization>;
}

export interface HermesArtifactReader {
  readExport(input: { machineId: string; path: string; maxBytes: number; noFollow: true }): Promise<ExportedFile>;
}

/**
 * Copies one completed Hermes output into private durable Storage while the
 * account-wide Hermes fence is still current. The caller must invoke this
 * before releasing hermes_workspaces.active_run.
 */
export async function exportHermesArtifact(input: {
  ownerId: string;
  runId: string;
  executionVersion: number;
  finalOutputKey: string;
  relativePath: string;
  policy: WorkspacePolicy;
  authorizer: HermesArtifactAuthorizer;
  reader: HermesArtifactReader;
  store: PrivateArtifactStore;
  repository: ArtifactRepository;
}) {
  const exportPath = normalizeExportPath(input.relativePath, input.policy);
  const authorizationInput = {
    ownerId: input.ownerId,
    runId: input.runId,
    executionVersion: input.executionVersion,
    exportPath,
  };
  const before = await input.authorizer.authorize(authorizationInput);
  const exported = await input.reader.readExport({
    machineId: before.machineId,
    path: exportPath,
    maxBytes: input.policy.maxExportBytes,
    noFollow: true,
  });
  const after = await input.authorizer.authorize(authorizationInput);
  if (after.machineId !== before.machineId) throw new ComputerFoundationError('LEASE_LOST');
  return persistExportedArtifact({
    ownerId: input.ownerId,
    runId: input.runId,
    finalOutputKey: input.finalOutputKey,
    relativePath: input.relativePath,
    exported,
    executionVersion: input.executionVersion,
    resourceKey: `file:${exportPath}`,
    fencingToken: 0,
    policy: input.policy,
    store: input.store,
    repository: input.repository,
  });
}

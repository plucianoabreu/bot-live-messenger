export type ComputerState =
  | 'NOT_CREATED'
  | 'CREATING'
  | 'READY'
  | 'PAUSING'
  | 'PAUSED'
  | 'RESUMING'
  | 'UNAVAILABLE'
  | 'DESTROYING'
  | 'DESTROYED';

export type ComputerAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string };

export type ComputerIdentity = {
  providerReference: string;
  templateVersion: string;
};

export type CapturedFrame = {
  bytes: Uint8Array;
  contentType: 'image/png' | 'image/jpeg';
  capturedAt: Date;
};

export type ExportedFile = {
  canonicalPath: string;
  bytes: Uint8Array;
  mimeType: string;
  symlinkFree: boolean;
};

/**
 * Provider credentials and provider-specific control handles never cross this
 * interface. Callers persist only opaque provider references.
 */
export interface ComputerProvider {
  ensure(userId: string): Promise<ComputerIdentity>;
  state(computer: ComputerIdentity): Promise<ComputerState>;
  resume(computer: ComputerIdentity): Promise<void>;
  pause(computer: ComputerIdentity): Promise<void>;
  destroy(computer: ComputerIdentity): Promise<void>;
  act(computer: ComputerIdentity, action: ComputerAction): Promise<void>;
  captureFrame(computer: ComputerIdentity): Promise<CapturedFrame>;
  readExport(computer: ComputerIdentity, normalizedPath: string): Promise<ExportedFile>;
}

export class ComputerFoundationError extends Error {
  constructor(
    public readonly code:
      | 'INTEGRATION_UNAVAILABLE'
      | 'INVALID_PATH'
      | 'UNSAFE_PATH'
      | 'UNSAFE_DESTINATION'
      | 'RESOURCE_BUSY'
      | 'RESOURCE_RECONCILIATION_REQUIRED'
      | 'LEASE_LOST'
      | 'ACTION_LIMIT'
      | 'WATCH_EXPIRED'
      | 'ARTIFACT_NOT_FOUND'
      | 'ARTIFACT_INVALID',
  ) {
    super(code);
    this.name = 'ComputerFoundationError';
  }
}

export type Clock = { now(): Date };
export const systemClock: Clock = { now: () => new Date() };

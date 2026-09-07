import 'node:crypto';

export function assertNodeWorker() {
  if (typeof window !== 'undefined') throw new Error('SERVER_RUNTIME_REQUIRED');
}

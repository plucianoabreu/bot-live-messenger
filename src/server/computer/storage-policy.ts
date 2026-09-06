import { ComputerFoundationError } from './contracts';

export type BucketInspector = {
  storage: { getBucket(bucket: string): Promise<{ data: { public: boolean } | null; error: unknown }> };
};

export async function verifyPrivateStorageBucket(bucket: string | undefined, inspector: BucketInspector) {
  if (!bucket) throw new ComputerFoundationError('INTEGRATION_UNAVAILABLE');
  const { data, error } = await inspector.storage.getBucket(bucket);
  if (error || !data || data.public !== false) throw new ComputerFoundationError('INTEGRATION_UNAVAILABLE');
  return bucket;
}

import { z } from 'zod';

export function isHermesTestUserAllowed(env: Record<string, string | undefined>, userId: string) {
  const configured = env.HERMES_TEST_USER_ID?.trim();
  if (!configured) return true;
  return z.uuid().safeParse(configured).success && configured === userId;
}

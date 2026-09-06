import { defineConfig } from '@trigger.dev/sdk';

export default defineConfig({
  project: 'proj_iuurzeceuzuvaoqmieae',
  runtime: 'node',
  dirs: ['./src/trigger'],
  maxDuration: 120,
  retries: { enabledInDev: false, default: { maxAttempts: 1 } },
});

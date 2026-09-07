import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Sandbox } from '@e2b/desktop';
import { HermesE2BFactory } from '../src/server/execution/hermes-e2b';
import { installHermesImage, HERMES_REVISION } from '../src/server/execution/hermes-provision';

async function main() {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error('E2B_API_KEY_MISSING');
  const machine = await new HermesE2BFactory(apiKey, 'desktop', 600_000, {
    version: 'hermes-image-build-v1',
    allowedHosts: [
      'archive.ubuntu.com', 'security.ubuntu.com',
      'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
      'pypi.org', 'files.pythonhosted.org',
    ],
  }).create(randomUUID());
  try {
    await installHermesImage(machine);
    await machine.run('/opt/blm-hermes/.venv/bin/python -c "import aiohttp; import gateway.platforms.api_server"');
    const snapshot = await Sandbox.createSnapshot(machine.id, { apiKey, name: `bot-live-hermes-${HERMES_REVISION.slice(0,7)}` });
    await mkdir('.local-setup', { recursive: true });
    await writeFile('.local-setup/hermes-image.json', JSON.stringify({ snapshotId: snapshot.snapshotId, revision: HERMES_REVISION }), { mode: 0o600 });
    console.log('Hermes image built. Binding saved in .local-setup/hermes-image.json.');
  } finally { await machine.destroy(); }
}
main().catch(() => { console.error('Hermes image build failed.'); process.exitCode = 1; });

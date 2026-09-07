import { Sandbox } from '@e2b/desktop';
import { z } from 'zod';
import type { HermesMachine, HermesMachineFactory } from './hermes-provision';

/** A separate VM for each account; no provider credentials are put in its environment. */
export class HermesE2BFactory implements HermesMachineFactory {
  constructor(private readonly apiKey: string, private readonly template = 'desktop', private readonly timeoutMs = 120_000) {
    if (!apiKey) throw new Error('E2B_API_KEY_MISSING');
  }

  async create(ownerId: string): Promise<HermesMachine> {
    z.uuid().parse(ownerId);
    const sandbox = await Sandbox.create(this.template, {
      apiKey: this.apiKey, timeoutMs: this.timeoutMs,
      lifecycle: { onTimeout: { action: 'pause', keepMemory: false }, autoResume: false },
      metadata: { application: 'bot-live-messenger', owner: ownerId, engine: 'hermes' },
    });
    return {
      id: sandbox.sandboxId,
      async write(path, contents) { await sandbox.files.write(path, contents, { user: 'root' }); },
      async run(command) {
        const result = await sandbox.commands.run(command, { user: 'root', timeoutMs: 240_000 });
        if (result.exitCode !== 0) throw new Error('HERMES_MACHINE_COMMAND_FAILED');
      },
      async start(command) {
        await sandbox.commands.run(command, { user: 'root', background: true, timeoutMs: 0 });
      },
      endpoint(port) { return `https://${sandbox.getHost(port)}`; },
      async destroy() { await sandbox.kill(); },
    };
  }
}

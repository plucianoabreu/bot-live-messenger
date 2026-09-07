import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  HERMES_EXPORT_REQUEST_PATH,
  HERMES_EXPORT_STAGED_PATH,
  HERMES_EXPORT_STAGE_COMMAND,
  hermesExportHelperSource,
  readHermesExport,
  type HermesExportSandbox,
} from '../src/server/execution/hermes-export-reader';

test('Hermes export stages through a fixed command and reads only the root-owned snapshot', async () => {
  const exportPath = '/workspace/exports/report $(touch injected).txt';
  const calls: Array<{ kind: string; value: unknown }> = [];
  const bytes = new TextEncoder().encode('safe snapshot');
  const sandbox: HermesExportSandbox = {
    files: {
      async write(path, contents, options) { calls.push({ kind: 'write', value: { path, contents, options } }); },
      async read(path, options) { calls.push({ kind: 'read', value: { path, options } }); return bytes; },
      async remove(path, options) { calls.push({ kind: 'remove', value: { path, options } }); },
    },
    commands: { async run(command, options) {
      calls.push({ kind: 'run', value: { command, options } });
      return { exitCode: 0, stdout: JSON.stringify({ canonicalPath: exportPath, size: bytes.byteLength }) };
    } },
  };

  const result = await readHermesExport(sandbox, exportPath, 1024);

  assert.deepEqual(result, {
    canonicalPath: exportPath, bytes, mimeType: 'application/octet-stream', symlinkFree: true,
  });
  assert.deepEqual(calls, [
    { kind: 'write', value: { path: HERMES_EXPORT_REQUEST_PATH,
      contents: JSON.stringify({ path: exportPath, maxBytes: 1024 }), options: { user: 'root' } } },
    { kind: 'run', value: { command: HERMES_EXPORT_STAGE_COMMAND, options: { user: 'root', timeoutMs: 30_000 } } },
    { kind: 'read', value: { path: HERMES_EXPORT_STAGED_PATH, options: { user: 'root', format: 'bytes' } } },
    { kind: 'remove', value: { path: HERMES_EXPORT_STAGED_PATH, options: { user: 'root' } } },
  ]);
  assert.doesNotMatch(HERMES_EXPORT_STAGE_COMMAND, /touch injected|report/);
});

test('Hermes export rejects inconsistent staged metadata and cleans the staged file', async () => {
  const removed: string[] = [];
  const sandbox: HermesExportSandbox = {
    files: {
      async write() {},
      async read() { assert.fail('metadata mismatch must prevent byte delivery'); },
      async remove(path) { removed.push(path); },
    },
    commands: { async run() { return { exitCode: 0, stdout: '{"canonicalPath":"/workspace/exports/other","size":1}' }; } },
  };
  await assert.rejects(readHermesExport(sandbox, '/workspace/exports/result.txt', 10), /ARTIFACT_READ_FAILED/);
  assert.deepEqual(removed, [HERMES_EXPORT_STAGED_PATH]);
});

test('Hermes export helper compiles and binds every path component without following symlinks', () => {
  const source = hermesExportHelperSource();
  execFileSync('python3', ['-c', 'import sys; compile(sys.argv[1], "hermes-export", "exec")', source]);
  assert.match(source, /os\.open\(part, DIRECTORY_FLAGS, dir_fd=directory_fd\)/);
  assert.match(source, /os\.open\(parts\[-1\], FILE_FLAGS, dir_fd=directory_fd\)/);
  assert.match(source, /os\.O_NOFOLLOW/);
  assert.match(source, /stat\.S_ISREG/);
  assert.match(source, /before\.st_uid != hermes_uid/);
  assert.match(source, /os\.replace\(temporary_path, STAGED_PATH\)/);
  assert.doesNotMatch(source, /subprocess|shell=True/);
});

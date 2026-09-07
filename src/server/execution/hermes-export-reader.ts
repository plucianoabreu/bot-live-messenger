import type { ExportedFile } from '../computer/contracts';

export const HERMES_EXPORT_ROOT = '/workspace/exports';
export const HERMES_EXPORT_HELPER_PATH = '/opt/blm-hermes-export.py';
export const HERMES_EXPORT_REQUEST_PATH = '/opt/blm-hermes-export/request.json';
export const HERMES_EXPORT_STAGED_PATH = '/opt/blm-hermes-export/staged.bin';
export const HERMES_EXPORT_STAGE_COMMAND = `python3 ${HERMES_EXPORT_HELPER_PATH}`;

const MAX_HERMES_EXPORT_BYTES = 64 * 1024 * 1024;

/**
 * This helper is installed root-owned and is invoked without arguments. The
 * requested path travels through a root-only JSON file rather than a shell.
 * Each path component is opened relative to the preceding directory fd with
 * O_NOFOLLOW, and the bound source fd is copied into a root-only staging file.
 */
export function hermesExportHelperSource() {
  return [
    'import json, os, pwd, secrets, stat',
    `EXPORT_ROOT = ${JSON.stringify(HERMES_EXPORT_ROOT)}`,
    `REQUEST_PATH = ${JSON.stringify(HERMES_EXPORT_REQUEST_PATH)}`,
    `STAGED_PATH = ${JSON.stringify(HERMES_EXPORT_STAGED_PATH)}`,
    `MAX_EXPORT_BYTES = ${MAX_HERMES_EXPORT_BYTES}`,
    'DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW',
    'FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK',
    '',
    'def fail():',
    '    raise SystemExit("ARTIFACT_READ_FAILED")',
    '',
    'try:',
    '    os.unlink(STAGED_PATH)',
    'except FileNotFoundError:',
    '    pass',
    '',
    'request_fd = os.open(REQUEST_PATH, os.O_RDONLY | os.O_NOFOLLOW)',
    'try:',
    '    request_stat = os.fstat(request_fd)',
    '    if not stat.S_ISREG(request_stat.st_mode) or request_stat.st_uid != 0 or request_stat.st_size > 4096:',
    '        fail()',
    '    with os.fdopen(request_fd, "r", encoding="utf-8") as request_file:',
    '        request_fd = -1',
    '        request = json.load(request_file)',
    'finally:',
    '    if request_fd >= 0:',
    '        os.close(request_fd)',
    '    try:',
    '        os.unlink(REQUEST_PATH)',
    '    except FileNotFoundError:',
    '        pass',
    '',
    'if not isinstance(request, dict) or set(request) != {"path", "maxBytes"}:',
    '    fail()',
    'requested_path = request["path"]',
    'max_bytes = request["maxBytes"]',
    'prefix = EXPORT_ROOT + "/"',
    'if (not isinstance(requested_path, str) or "\\x00" in requested_path or "\\\\" in requested_path or',
    '        len(requested_path.encode("utf-8")) > 4096 or not requested_path.startswith(prefix)):',
    '    fail()',
    'if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or not 1 <= max_bytes <= MAX_EXPORT_BYTES:',
    '    fail()',
    'parts = requested_path[len(prefix):].split("/")',
    'if not parts or any(part in ("", ".", "..") for part in parts):',
    '    fail()',
    '',
    'root_fd = os.open(EXPORT_ROOT, DIRECTORY_FLAGS)',
    'directory_fd = root_fd',
    'source_fd = -1',
    'temporary_path = None',
    'try:',
    '    for part in parts[:-1]:',
    '        next_fd = os.open(part, DIRECTORY_FLAGS, dir_fd=directory_fd)',
    '        if directory_fd != root_fd:',
    '            os.close(directory_fd)',
    '        directory_fd = next_fd',
    '    source_fd = os.open(parts[-1], FILE_FLAGS, dir_fd=directory_fd)',
    '    before = os.fstat(source_fd)',
    '    hermes_uid = pwd.getpwnam("blm-hermes").pw_uid',
    '    if not stat.S_ISREG(before.st_mode) or before.st_uid != hermes_uid or not 1 <= before.st_size <= max_bytes:',
    '        fail()',
    '',
    '    temporary_path = STAGED_PATH + "." + str(os.getpid()) + "." + secrets.token_hex(12)',
    '    staged_fd = os.open(temporary_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)',
    '    copied = 0',
    '    try:',
    '        while True:',
    '            chunk = os.read(source_fd, min(65536, max_bytes + 1 - copied))',
    '            if not chunk:',
    '                break',
    '            copied += len(chunk)',
    '            if copied > max_bytes:',
    '                fail()',
    '            view = memoryview(chunk)',
    '            while view:',
    '                view = view[os.write(staged_fd, view):]',
    '        os.fsync(staged_fd)',
    '    finally:',
    '        os.close(staged_fd)',
    '    after = os.fstat(source_fd)',
    '    if (copied != before.st_size or after.st_size != before.st_size or',
    '            after.st_mtime_ns != before.st_mtime_ns or after.st_ctime_ns != before.st_ctime_ns):',
    '        fail()',
    '    os.replace(temporary_path, STAGED_PATH)',
    '    temporary_path = None',
    '    os.chmod(STAGED_PATH, 0o600)',
    '    print(json.dumps({"canonicalPath": requested_path, "size": copied}, separators=(",", ":")))',
    'finally:',
    '    if source_fd >= 0:',
    '        os.close(source_fd)',
    '    if directory_fd != root_fd:',
    '        os.close(directory_fd)',
    '    os.close(root_fd)',
    '    if temporary_path is not None:',
    '        try:',
    '            os.unlink(temporary_path)',
    '        except FileNotFoundError:',
    '            pass',
    '',
  ].join('\n');
}

export type HermesExportSandbox = {
  files: {
    write(path: string, contents: string, options: { user: 'root' }): Promise<unknown>;
    read(path: string, options: { user: 'root'; format: 'bytes' }): Promise<Uint8Array>;
    remove(path: string, options: { user: 'root' }): Promise<unknown>;
  };
  commands: {
    run(command: string, options: { user: 'root'; timeoutMs: number }): Promise<{
      exitCode: number;
      stdout?: string;
      stderr?: string;
    }>;
  };
};

/** Reads only the root-staged snapshot produced by the fixed export helper. */
export async function readHermesExport(
  sandbox: HermesExportSandbox,
  exportPath: string,
  maxBytes: number,
): Promise<ExportedFile> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_HERMES_EXPORT_BYTES) {
    throw new Error('ARTIFACT_READ_FAILED');
  }
  await sandbox.files.write(HERMES_EXPORT_REQUEST_PATH, JSON.stringify({ path: exportPath, maxBytes }), { user: 'root' });
  let staged = false;
  try {
    const result = await sandbox.commands.run(HERMES_EXPORT_STAGE_COMMAND, { user: 'root', timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error('ARTIFACT_READ_FAILED');
    staged = true;
    let metadata: unknown;
    try { metadata = JSON.parse(result.stdout?.trim() ?? ''); } catch { throw new Error('ARTIFACT_READ_FAILED'); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('ARTIFACT_READ_FAILED');
    const record = metadata as Record<string, unknown>;
    if (record.canonicalPath !== exportPath || !Number.isSafeInteger(record.size) || Number(record.size) < 1 || Number(record.size) > maxBytes) {
      throw new Error('ARTIFACT_READ_FAILED');
    }
    const bytes = await sandbox.files.read(HERMES_EXPORT_STAGED_PATH, { user: 'root', format: 'bytes' });
    if (bytes.byteLength !== record.size) throw new Error('ARTIFACT_READ_FAILED');
    return { canonicalPath: exportPath, bytes, mimeType: 'application/octet-stream', symlinkFree: true };
  } finally {
    if (staged) {
      await sandbox.files.remove(HERMES_EXPORT_STAGED_PATH, { user: 'root' });
    }
  }
}

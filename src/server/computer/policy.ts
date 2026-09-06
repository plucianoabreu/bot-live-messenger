import path from 'node:path';
import { isIP } from 'node:net';
import { ComputerFoundationError, type ComputerAction, type ExportedFile } from './contracts';

export type WorkspacePolicy = {
  workspaceRoot: string;
  exportRoot: string;
  maxExportBytes: number;
  allowedHosts: ReadonlySet<string>;
  maxRedirects: number;
};

export const defaultWorkspacePolicy: WorkspacePolicy = {
  workspaceRoot: '/workspace',
  exportRoot: '/workspace/exports',
  maxExportBytes: 10 * 1024 * 1024,
  allowedHosts: new Set(),
  maxRedirects: 3,
};

function inside(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function normalizeExportPath(input: string, policy: WorkspacePolicy = defaultWorkspacePolicy) {
  if (!input || input.length > 512 || input.includes('\0') || input.includes('\\') || path.posix.isAbsolute(input)) {
    throw new ComputerFoundationError('INVALID_PATH');
  }
  const normalizedRelative = path.posix.normalize(input);
  if (normalizedRelative === '.' || normalizedRelative === '..' || normalizedRelative.startsWith('../')) {
    throw new ComputerFoundationError('INVALID_PATH');
  }
  const root = path.posix.resolve(policy.exportRoot);
  const resolved = path.posix.resolve(root, normalizedRelative);
  if (!inside(root, resolved)) throw new ComputerFoundationError('INVALID_PATH');
  return resolved;
}

export function validateExportedFile(file: ExportedFile, requestedPath: string, policy: WorkspacePolicy = defaultWorkspacePolicy) {
  const expected = normalizeExportPath(requestedPath, policy);
  const root = path.posix.resolve(policy.exportRoot);
  const canonical = path.posix.resolve(file.canonicalPath);
  if (!file.symlinkFree || !inside(root, canonical) || canonical !== expected) {
    throw new ComputerFoundationError('UNSAFE_PATH');
  }
  if (file.bytes.byteLength < 1 || file.bytes.byteLength > policy.maxExportBytes) {
    throw new ComputerFoundationError('ARTIFACT_INVALID');
  }
  return file;
}

function blockedIpv4(address: string) {
  const parts = address.split('.').map(Number);
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 31 && c === 196) ||
      (b === 52 && c === 193) || (b === 88 && c === 99) || (b === 175 && c === 48))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) || a >= 224;
}

function blockedIpv6(address: string) {
  const words = ipv6Words(address);
  if (!words) return true;
  const allZero = words.every(word => word === 0);
  const loopback = words.slice(0, 7).every(word => word === 0) && words[7] === 1;
  const uniqueLocal = (words[0] & 0xfe00) === 0xfc00;
  const linkLocal = (words[0] & 0xffc0) === 0xfe80;
  const siteLocal = (words[0] & 0xffc0) === 0xfec0;
  const multicast = (words[0] & 0xff00) === 0xff00;
  const documentation = words[0] === 0x2001 && words[1] === 0x0db8;
  const mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
  const compatible = words.slice(0, 6).every(word => word === 0);
  const embeddedV4 = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  const globalUnicast = (words[0] & 0xe000) === 0x2000;
  const ianaSpecial2001 = words[0] === 0x2001 && words[1] < 0x0200; // 2001::/23
  const sixToFour = words[0] === 0x2002;
  const sixToFourV4 = `${words[1] >> 8}.${words[1] & 255}.${words[2] >> 8}.${words[2] & 255}`;
  const teredo = words[0] === 0x2001 && words[1] === 0;
  const teredoClientV4 = `${(~words[6] >>> 8) & 255}.${~words[6] & 255}.${(~words[7] >>> 8) & 255}.${~words[7] & 255}`;
  const former6Bone = words[0] === 0x3ffe;
  const documentationV2 = words[0] >= 0x3fff && words[0] <= 0x3fff && (words[1] & 0xf000) === 0;
  const as112 = words[0] === 0x2620 && words[1] === 0x004f && words[2] === 0x8000;
  // Translation, mapped, compatible, 6to4 and Teredo space is never accepted;
  // decoding the embedded address also prevents private IPv4 from hiding in it.
  const unsafeEmbedded = ((mapped || compatible) && blockedIpv4(embeddedV4)) ||
    (sixToFour && blockedIpv4(sixToFourV4)) || (teredo && blockedIpv4(teredoClientV4));
  return !globalUnicast || allZero || loopback || uniqueLocal || linkLocal || siteLocal || multicast || documentation ||
    ianaSpecial2001 || sixToFour || teredo || former6Bone || documentationV2 || as112 || mapped || compatible || unsafeEmbedded;
}

function ipv6Words(input: string): number[] | null {
  let value = input.toLowerCase().split('%')[0];
  if (value.includes('.')) {
    const boundary = value.lastIndexOf(':');
    const v4 = value.slice(boundary + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    value = `${value.slice(0, boundary)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  if ((value.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = value.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (value.includes('::') ? missing < 1 : missing !== 0) return null;
  return [...left.map(part => parseInt(part, 16)), ...Array(missing).fill(0), ...right.map(part => parseInt(part, 16))];
}

export function isPrivateOrSpecialAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return blockedIpv4(address);
  if (version === 6) return blockedIpv6(address);
  return true;
}

/** Validates every hop. DNS/IP enforcement must also exist outside the guest. */
export function validateDestination(rawUrl: string, resolvedAddresses: readonly string[], redirectCount: number, policy: WorkspacePolicy) {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new ComputerFoundationError('UNSAFE_DESTINATION'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || redirectCount > policy.maxRedirects ||
    !policy.allowedHosts.has(host) || resolvedAddresses.length === 0 || resolvedAddresses.some(isPrivateOrSpecialAddress)) {
    throw new ComputerFoundationError('UNSAFE_DESTINATION');
  }
  return url;
}

export function validateComputerAction(action: unknown): ComputerAction {
  if (!action || typeof action !== 'object') throw new ComputerFoundationError('UNSAFE_DESTINATION');
  const value = action as Record<string, unknown>;
  if (value.type === 'click' && Number.isInteger(value.x) && Number.isInteger(value.y) &&
    Number(value.x) >= 0 && Number(value.x) <= 3840 && Number(value.y) >= 0 && Number(value.y) <= 2160) {
    return { type: 'click', x: Number(value.x), y: Number(value.y) };
  }
  if (value.type === 'type' && typeof value.text === 'string' && value.text.length >= 1 && value.text.length <= 4000) {
    return { type: 'type', text: value.text };
  }
  if (value.type === 'key' && typeof value.key === 'string' && /^[A-Za-z0-9]{1,16}$/.test(value.key)) {
    return { type: 'key', key: value.key };
  }
  if (value.type === 'navigate' && typeof value.url === 'string' && value.url.length <= 2048) {
    return { type: 'navigate', url: value.url };
  }
  throw new ComputerFoundationError(value.type === 'navigate' ? 'UNSAFE_DESTINATION' : 'LEASE_LOST');
}

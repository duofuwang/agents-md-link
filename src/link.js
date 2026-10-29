import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SYMLINK_FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'ENOSYS', 'EINVAL', 'UNKNOWN']);

let symlinkCapabilityCache;

export async function lstatSafe(file) {
  try {
    return await fs.lstat(file, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function statSafe(file) {
  try {
    return await fs.stat(file, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function realpathSafe(file) {
  try {
    return await fs.realpath(file);
  } catch {
    return null;
  }
}

export function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function samePath(a, b) {
  const [realA, realB] = await Promise.all([realpathSafe(a), realpathSafe(b)]);
  if (!realA || !realB) return false;
  return pathKey(realA) === pathKey(realB);
}

export async function sameFile(a, b) {
  const [statA, statB] = await Promise.all([statSafe(a), statSafe(b)]);
  if (!statA || !statB) return false;
  if (statA.ino === 0n || statB.ino === 0n) return false;
  return statA.dev === statB.dev && statA.ino === statB.ino;
}

export async function inspectTarget(targetPath, sourcePath) {
  const info = await lstatSafe(targetPath);
  if (!info) return { kind: 'missing', hasContent: false };

  if (info.isSymbolicLink()) {
    const raw = await fs.readlink(targetPath);
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(targetPath), raw);
    const real = await realpathSafe(resolved);
    if (!real) {
      return { kind: 'symlink', broken: true, pointsToSource: false, readlink: raw, hasContent: false };
    }
    return {
      kind: 'symlink',
      broken: false,
      pointsToSource: await samePath(resolved, sourcePath),
      readlink: raw,
      hasContent: true,
    };
  }

  if (info.isFile()) {
    const sourceStat = await statSafe(sourcePath);
    const sameInode =
      sourceStat !== null &&
      info.ino !== 0n &&
      sourceStat.ino !== 0n &&
      info.dev === sourceStat.dev &&
      info.ino === sourceStat.ino;
    return { kind: sameInode ? 'hardlink' : 'file', sameInode, hasContent: info.size > 0n };
  }

  return { kind: 'other', hasContent: false };
}

export async function symlinkCapability() {
  if (symlinkCapabilityCache !== undefined) return symlinkCapabilityCache;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-md-sync-probe-'));
  const target = path.join(directory, 'target.txt');
  const link = path.join(directory, 'link.txt');
  try {
    await fs.writeFile(target, 'x');
    await fs.symlink(target, link, 'file');
    symlinkCapabilityCache = true;
  } catch {
    symlinkCapabilityCache = false;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  return symlinkCapabilityCache;
}

export async function createLink(sourcePath, targetPath, mode = 'auto') {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (mode === 'symlink') {
    await fs.symlink(path.relative(path.dirname(targetPath), sourcePath), targetPath, 'file');
    return { type: 'linked' };
  }
  if (mode === 'hardlink') {
    await fs.link(sourcePath, targetPath);
    return { type: 'hardlinked' };
  }
  if (mode !== 'auto') {
    throw new Error(`Unknown link mode: ${mode}`);
  }

  try {
    await fs.symlink(path.relative(path.dirname(targetPath), sourcePath), targetPath, 'file');
    return { type: 'linked' };
  } catch (error) {
    if (!SYMLINK_FALLBACK_CODES.has(error.code)) throw error;
    await fs.link(sourcePath, targetPath);
    return { type: 'hardlinked', symlinkError: error.code };
  }
}

export async function removeTarget(targetPath) {
  await fs.unlink(targetPath);
}

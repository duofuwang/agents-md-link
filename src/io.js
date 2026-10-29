import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class UnsupportedEncodingError extends Error {
  constructor(file) {
    super(`${file} is UTF-16; not supported`);
    this.name = 'UnsupportedEncodingError';
    this.code = 'EUNSUPPORTEDENCODING';
  }
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readIfExists(file) {
  try {
    return await readText(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readText(file) {
  const buffer = await fs.readFile(file);
  if (buffer.length >= 2) {
    const [a, b] = buffer;
    if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) {
      throw new UnsupportedEncodingError(file);
    }
  }
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const body = bom ? buffer.subarray(3) : buffer;
  const text = body.toString('utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { text, bom, eol, size: buffer.length };
}

export async function writeTextAtomic(file, text, { bom = false, eol = '\n' } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const output = encodeText(text, { bom, eol });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, output);
  try {
    await fs.rename(temp, file);
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    await fs.rm(file, { force: true });
    await fs.rename(temp, file);
  }
}

export async function writeTextInPlace(file, text, { bom = false, eol = '\n' } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, encodeText(text, { bom, eol }));
}

function encodeText(text, { bom, eol }) {
  const normalized = normalizeText(text);
  const withEol = eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
  const body = Buffer.from(withEol, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

export function normalizeText(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

export function hashText(text) {
  return createHash('sha256').update(normalizeText(text)).digest('hex');
}

export function contentEquals(a, b) {
  return hashText(a) === hashText(b);
}

export function templateSource() {
  return '# AGENTS.md\n\n<!-- agents-md-sync:template -->\n';
}

export function isTemplateOnly(text) {
  if (!text) return true;
  const stripped = normalizeText(text)
    .replace(/^#\s*AGENTS\.md\s*/i, '')
    .replace(/<!--\s*agents-md-sync:template\s*-->/gi, '')
    .trim();
  return stripped === '';
}

export const MANAGED_COPY_HEADER =
  '<!-- agents-md-sync: generated from ~/.agents/AGENTS.md; do not edit -->';

export function managedCopy(sourceText) {
  return `${MANAGED_COPY_HEADER}\n\n${normalizeText(sourceText).trimEnd()}\n`;
}

export function isManagedCopy(text) {
  return normalizeText(text).startsWith(MANAGED_COPY_HEADER);
}

export function stripManagedCopy(text) {
  const normalized = normalizeText(text);
  if (!normalized.startsWith(MANAGED_COPY_HEADER)) return normalized;
  return normalized.slice(MANAGED_COPY_HEADER.length).replace(/^\n+/, '');
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function sanitizeSegment(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_');
}

export async function copyFile(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

export async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true });
}

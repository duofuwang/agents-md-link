import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function makeHome() {
  return mkdtemp(path.join(os.tmpdir(), 'agents-md-sync-test-'));
}

export async function put(home, relative, content) {
  const file = path.join(home, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

export async function cleanup(home) {
  await rm(home, { recursive: true, force: true });
}

export async function quiet(fn) {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

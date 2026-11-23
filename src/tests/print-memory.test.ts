import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import { readPrintCgroupMemory } from '@/services/print-memory.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'print-cgroup-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('reads cgroup v1 memory usage and limit hits from the memory controller', async () => {
  const memory = join(root, 'memory');
  await mkdir(memory);
  await writeFile(join(memory, 'memory.usage_in_bytes'), '100\n');
  await writeFile(join(memory, 'memory.max_usage_in_bytes'), '180\n');
  await writeFile(join(memory, 'memory.limit_in_bytes'), '200\n');
  await writeFile(join(memory, 'memory.failcnt'), '0\n');
  expect(await readPrintCgroupMemory(root)).toEqual({
    version: 1,
    currentBytes: '100',
    peakBytes: '180',
    limitBytes: '200',
    failCount: '0',
  });
});

it('reads cgroup v2 even when the kernel omits the optional peak file', async () => {
  await writeFile(join(root, 'memory.current'), '150\n');
  await writeFile(join(root, 'memory.max'), 'max\n');
  await writeFile(join(root, 'memory.events'), 'oom_kill 0\n');
  expect(await readPrintCgroupMemory(root)).toEqual({
    version: 2,
    currentBytes: '150',
    peakBytes: null,
    limitBytes: 'max',
    events: 'oom_kill 0',
  });
});

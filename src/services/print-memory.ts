import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/config/logger.js';

export async function readPrintCgroupMemory(root = '/sys/fs/cgroup') {
  const read = (file: string) =>
    readFile(join(root, file), 'utf8')
      .then((value) => value.trim())
      .catch(() => null);
  const current = await read('memory.current');
  if (current !== null) {
    const [peakBytes, limitBytes, events] = await Promise.all(
      ['memory.peak', 'memory.max', 'memory.events'].map(read),
    );
    return { version: 2, currentBytes: current, peakBytes, limitBytes, events };
  }
  const [currentBytes, peakBytes, limitBytes, failCount] = await Promise.all(
    ['usage_in_bytes', 'max_usage_in_bytes', 'limit_in_bytes', 'failcnt'].map((name) =>
      read(`memory/memory.${name}`),
    ),
  );
  return currentBytes === null
    ? null
    : { version: 1, currentBytes, peakBytes, limitBytes, failCount };
}

export async function logPrintMemory(stage: string, context: { storyId: string; runId: string }) {
  const node = process.memoryUsage();
  const cgroup = process.platform === 'linux' ? await readPrintCgroupMemory() : null;

  logger.info('Print memory sample', {
    event: 'print_memory_sample',
    ...context,
    stage,
    node,
    nodeMaxRssBytes: process.resourceUsage().maxRSS * 1024,
    cgroup,
  });
}

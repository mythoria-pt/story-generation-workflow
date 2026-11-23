import { readFile } from 'node:fs/promises';
import { logger } from '@/config/logger.js';

const cgroupPaths = {
  currentBytes: 'memory.current',
  peakBytes: 'memory.peak',
  limitBytes: 'memory.max',
  events: 'memory.events',
};

export async function logPrintMemory(stage: string, context: { storyId: string; runId: string }) {
  const node = process.memoryUsage();
  const cgroup =
    process.platform === 'linux'
      ? Object.fromEntries(
          await Promise.all(
            Object.entries(cgroupPaths).map(async ([key, path]) => [
              key,
              await readFile(`/sys/fs/cgroup/${path}`, 'utf8')
                .then((value) => value.trim())
                .catch(() => null),
            ]),
          ),
        )
      : null;

  logger.info('Print memory sample', {
    event: 'print_memory_sample',
    ...context,
    stage,
    node,
    nodeMaxRssBytes: process.resourceUsage().maxRSS * 1024,
    cgroup,
  });
}

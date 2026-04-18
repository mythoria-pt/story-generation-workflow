import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';

describe('print-generation workflow', () => {
  it('includes QA review and admin alert steps before self-service notification', () => {
    const workflow = readFileSync(
      join(process.cwd(), 'workflows', 'print-generation.yaml'),
      'utf-8',
    );

    expect(workflow).toContain('/internal/print/quality-check');
    expect(workflow).toContain('/internal/print/quality-alert');
    expect(workflow).toContain('printQaStatus');
    expect(workflow.indexOf('/internal/print/quality-check')).toBeLessThan(
      workflow.indexOf('/internal/print/self-service/notify'),
    );
    expect(workflow).toContain('${origin == "self-service" and delivery != null}');
    expect(workflow).toContain('printResult: ${qaResult.body.printResult}');
  });
});

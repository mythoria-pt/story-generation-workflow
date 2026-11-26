import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';

describe('print-generation workflow', () => {
  it('uses its own worker and terminal steps for staff PDF exports', () => {
    const workflow = readFileSync(
      join(process.cwd(), 'workflows', 'print-generation.yaml'),
      'utf-8',
    );
    expect(workflow).toContain('== true or adminPrintAttempt != null');
    expect(workflow).toMatch(/adminPrintAttempt != null\}\s+next: renderStaffExport/);
    expect(workflow).toContain('/internal/print/premium-admin/worker-lost');
    expect(workflow).toMatch(
      /next: finishStaffExport\s+- finishStaffExport:\s+return: \$\{runId\}/,
    );
  });

  it('uses the square renderer QA result for premium downloads', () => {
    const workflow = readFileSync(
      join(process.cwd(), 'workflows', 'print-generation.yaml'),
      'utf-8',
    );
    expect(workflow).toMatch(
      /- recordPremiumQA:\s+assign:\s+- qaStatus: 'passed'\s+- qaSkip: false\s+next: initializeDeliveryStatus/,
    );
    expect(workflow).toMatch(
      /condition: \$\{map\.get\(activePrintResult, "premiumRevision"\) != null\}\s+next: recordPremiumQA/,
    );
  });

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
    expect(workflow).toMatch(
      /- setOriginSelfService:[\s\S]*?- originGuess: 'self-service'\s+next: setOriginDefault/,
    );
    expect(workflow).toMatch(
      /- setOriginAdmin:[\s\S]*?- originGuess: 'admin'\s+next: setOriginDefault/,
    );
    expect(workflow).toContain('printResult: ${activePrintResult}');
    expect(workflow.indexOf('- saveGeneratedAssets:')).toBeLessThan(
      workflow.indexOf('- qualityCheckPDF:'),
    );
    expect(workflow).toMatch(
      /- qualityCheckPDF:[\s\S]*?except:\s+as: qaError[\s\S]*?qaStatus: 'review_failed'/,
    );
    expect(workflow).toMatch(
      /- notifyPrintQaAdmins:[\s\S]*?except:\s+as: alertError[\s\S]*?- markRunCompleted:/,
    );
    expect(workflow).toContain('predicate: ${retryPrintQaAlertBeforeDispatch}');
    expect(workflow).toContain(
      'return: ${map.get(error, "code") == 502 and map.get(error, ["body", "reason"]) == "manager_lookup_failed"}',
    );
    expect(workflow).toContain('printQaAlertFailureReason: ${qaAlertFailureReason}');
    expect(workflow).toContain("event: 'print_qa_alert_delivery_failed'");
    expect(workflow).toContain('/internal/runs/" + runId + "/claim');
    expect(workflow.indexOf('- markRunCompleted:')).toBeLessThan(
      workflow.indexOf('- notifySelfPrintCustomers:'),
    );
    expect(workflow).toContain('failureStage: ${currentStage}');
  });
});

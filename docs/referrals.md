# Referral funnel integration

Updated 2026-09-09. See [the cross-service runbook](../../docs/REFERRALS.md).

WebApp owns referral attribution and snapshots on stories. SGW's existing analytics reconciliation writes the durable story_generation_requests terminal status independently of GA4 eligibility. The WebApp-owned referral_generation_funnel trigger records one story_generated event per attributed story on successful completion. Retries and regenerations do not multiply that funnel count. No story title, prompt or content is sent to the partner portal.

There is no additional SGW referral webhook, credential or GA4 requirement. Keep terminal status persistence in its transaction. The shared schema mirror includes referrals.ts because stories.ts references attribution owners and assignments. Refresh through scripts/sync-schema.ps1; never author a referral migration in workflows_db. Deployment requires WebApp schema migrations first. Normal quality gates apply after synchronization.

## Production release — 2026-09-12

Verified revision: `story-generation-workflow-00132-xx2`; image source: `27373ecaf028751d1aeaefbd703db0b6c219a6bc`. The revision passed HTTP 200 health and serves 100% of traffic. The release includes the referral implementation and the other reviewed local changes. See the WebApp's `docs/referrals-release-2026-09-12.md` for cross-service proof and remaining operating work.

Referral Scheduler jobs and the external signup/Checkout/email/settlement journey matrix remain outstanding. Package audit warnings remain documented in that release record. Runtime health is a bounded check, not proof of payment or email delivery.

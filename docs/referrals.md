# Referral funnel integration

Updated 2026-09-09. See [the cross-service runbook](../../docs/REFERRALS.md).

WebApp owns referral attribution and snapshots on stories. SGW's existing analytics reconciliation writes the durable story_generation_requests terminal status independently of GA4 eligibility. The WebApp-owned referral_generation_funnel trigger records one story_generated event per attributed story on successful completion. Retries and regenerations do not multiply that funnel count. No story title, prompt or content is sent to the partner portal.

There is no additional SGW referral webhook, credential or GA4 requirement. Keep terminal status persistence in its transaction. The shared schema mirror includes referrals.ts because stories.ts references attribution owners and assignments. Refresh through scripts/sync-schema.ps1; never author a referral migration in workflows_db. Deployment requires WebApp schema migrations first. Normal quality gates apply after synchronization.

# Story and print incident diagnostics

## Print review and customer delivery

Read the run metadata for the generated PDFs, `printQaStatus`, `printQaAlertSent` and `printDeliveryStatus`. An available PDF can be delivered when review fails. A completed Workflows execution alone does not confirm a quality pass or an email delivery. The Admin workflow card displays these outcomes individually.

Configure the Workflow service with `MYTHORIA_ADMIN_URL` and bind `MYTHORIA_ADMIN_API_KEY` to the same Secret Manager version used by the Admin managers endpoint. Maintain these bindings during subsequent deployments. The independent Cloud Monitoring policy **Mythoria — print QA alert delivery failed** watches the final structured Workflows ERROR event `print_qa_alert_delivery_failed` for `print-generation`. A dedicated `mythoria-print-qa-alert-test` log on the global resource exercises the same policy when its JSON payload contains that event and `test: true`. Scope alert channel configuration to operations. Use authorized test recipients for mail checks.

## Story structure

A benign request using the production story schema reproduced an OpenAI HTTP 400 for `text.format.schema`. After closing the object schema and making optional fields nullable, the same request identified the unsupported `top_p` parameter. The corrected request generated a complete story outline with a character. The original production requests withheld private error bodies, so their individual error parameters cannot be established retrospectively.

Investigate provider, model, HTTP status, code, parameter and request ID. A confirmed refusal is persisted as `STORY_CONTENT_DECLINED`. A technical error following an earlier refusal is reported as a technical failure. Do not put author text, request bodies or identifying photos in diagnostic logs.

## Following the release

Compare counts by revision, route and operation for the first 24 hours. Track PDF memory by stage, the final QA and notification result, structure-job status, image download/inference/persistence time, readiness conflicts per final author turn, and the field-level Step 5 validation reason. Check active voice sessions against final saved turns and watch successive audio sweeps for a sustained backlog. Use a synthetic draft to verify the full flow when traffic is low. The existing Notification Engine `Campaign batch dispatch completed` event includes processed, sent, failed and durationMs. In the November 23 audit five 27-recipient batches took 15–34 seconds each, while an empty batch took 40 milliseconds.

## November 23 release checks

The print workflow ran in Google Workflows with its nine HTTP operations replaced by synthetic responses. A successful quality check reached delivery. A simulated QA outage also reached delivery using the original PDFs and recorded `review_failed`. When the simulated team notification reported a partial send, Cloud Logging recorded `print_qa_alert_delivery_failed`. A failure to generate the PDFs ended the execution before delivery. These tests exercised orchestration without creating orders or contacting recipients.

A separate test log opened an incident under the production Monitoring policy at 22:14 UTC. To diagnose email delivery, inspect the policy’s incident history and the `monitoring.googleapis.com/notification_channel_events` error log. Confirm inbox receipt separately.

For Guide response time, six synthetic European Portuguese conversations ran twice per variant with the same Gemini 4 Hydrogen prompt and low thinking. Full history took a median of 4.87 seconds and compact history 4.45 seconds. Comparing like-for-like requests, compact history won six of twelve pairs and its median saving was 34 milliseconds. One partial plot assessment changed. Keep full history and remeasure using production timings before changing the context policy.

# Database maintenance
We need to have a peridocid service (daily), that keeps the database and file storage cleaned and optimized.
For that, we need to create an endpoint, which will be periodically (once a day), called by Google Scheduler.

This service must focus on cleaning:
## A. Database cleaning
### workflows_db
On the `workflows_db`, we need to delete the `story_generation_runs` and `story_generation_steps` entries, that are older (`created_at` field) than 30 days.
To reduce the DB operation, limit to only delete 100 records per run.

On the `token_usage_tracking` delete the records older than 90 days. Again, limit the delete to 100 records per execution.

### mythoria_db
Delete all the existing stories, with `created_at` date older than 48h, and with the status `temporary`.


# Deployment Checklist - Retry & Safety Block Implementation

**Date**: October 10, 2025  
**Feature**: Image Generation Retry & AI-Powered Safety Block Handling

---

## ✅ Pre-Deployment (COMPLETED)

- [x] **Code Implementation**: All retry logic and safety block handling implemented
- [x] **Type Safety**: TypeScript compilation passes (`npm run typecheck`)
- [x] **Database Migrations**: 
  - [x] Main DB: Added `'prompt_rewrite'` to `ai_action_type` enum
  - [x] Workflows DB: Migrations completed successfully
- [x] **Documentation**: 
  - [x] `docs/ARCHITECTURE.md` updated
  - [x] `AGENTS.md` updated
  - [x] `docs/RETRY_IMPLEMENTATION_SUMMARY.md` created

---

## 🚀 Deployment Steps

### 1. Build and Test Locally (Optional but Recommended)

```powershell
# Build the project
npm run build

# Run tests (if applicable)
npm test

# Start locally to verify
npm run dev
```

### 2. Deploy to Google Cloud

**Option A: Full Deployment (Recommended for first deploy)**
```powershell
npm run deploy
```
This will:
- Build Docker container
- Push to Google Container Registry
- Deploy Cloud Run service
- Update Cloud Workflows YAML

**Option B: Fast Deployment (If no TypeScript changes)**
```powershell
npm run deploy:fast
```
This only updates the workflow YAML without rebuilding the container.

### 3. Verify Deployment

```powershell
# Check workflow definition
gcloud workflows describe story-generation --location=europe-west9

# Check Cloud Run service
gcloud run services describe story-generation-workflow --region=europe-west9

# View recent logs
npm run logs

# Tail logs in real-time
npm run logs:tail
```

---

## 🧪 Testing the Implementation

### Test 1: Verify Retry Logic for Transient Errors

**Scenario**: Simulate a transient error (if possible) or check logs for natural retries

**Expected Behavior**:
- First attempt fails with 500/503
- Workflow waits 60 seconds
- Retries up to 3 times
- Logs show: "attempt X failed, retrying after 60s"

**Check with**:
```powershell
npm run logs | Select-String "retry"
```

### Test 2: Verify Safety Block Handling

**Scenario**: Trigger a safety block with a potentially sensitive prompt

**Expected Behavior**:
1. Initial request returns 422 (not 500)
2. System attempts prompt rewrite using GenAI
3. Retries with rewritten prompt (1 attempt)
4. If still blocked: marks run as `blocked` (not `failed`)

**Check Run Status**:
```sql
SELECT 
  id, 
  status, 
  current_step, 
  error_message,
  created_at,
  ended_at
FROM story_generation_runs
WHERE status = 'blocked'
ORDER BY created_at DESC
LIMIT 5;
```

**Check Prompt Rewrites**:
```sql
SELECT 
  story_id,
  action,
  ai_model,
  input_tokens,
  output_tokens,
  created_at
FROM token_usage_tracking
WHERE action = 'prompt_rewrite'
ORDER BY created_at DESC
LIMIT 10;
```

### Test 3: Verify Workflow Doesn't Crash on 422

**Previous Bug**: Workflow failed with "HTTP 500 rethrow" error

**Expected Behavior**: 
- Workflow receives 422 response
- Marks run as `blocked`
- Returns gracefully without crashing

**Check Logs**:
```powershell
npm run logs | Select-String "422"
npm run logs | Select-String "SAFETY_BLOCKED"
```

---

## 📊 Monitoring After Deployment

### Key Metrics to Watch

1. **Retry Success Rate**
   ```sql
   -- Count retries vs successes
   SELECT 
     COUNT(*) FILTER (WHERE status = 'completed') AS completed,
     COUNT(*) FILTER (WHERE status = 'failed') AS failed,
     COUNT(*) FILTER (WHERE status = 'blocked') AS blocked
   FROM story_generation_runs
   WHERE created_at > NOW() - INTERVAL '24 hours';
   ```

2. **Prompt Rewrite Usage**
   ```sql
   -- Count prompt rewrites
   SELECT 
     COUNT(*) AS total_rewrites,
     DATE_TRUNC('hour', created_at) AS hour,
     AVG(input_tokens) AS avg_input_tokens,
     AVG(output_tokens) AS avg_output_tokens
   FROM token_usage_tracking
   WHERE action = 'prompt_rewrite'
     AND created_at > NOW() - INTERVAL '24 hours'
   GROUP BY hour
   ORDER BY hour DESC;
   ```

3. **Error Breakdown**
   ```powershell
   # View all errors in last hour
   npm run logs | Select-String "error|Error|ERROR" | Select-Object -Last 50
   
   # Filter for safety blocks
   npm run logs | Select-String "SAFETY_BLOCKED|moderation_blocked"
   
   # Filter for retries
   npm run logs | Select-String "retry|attempt"
   ```

---

## 🔧 Rollback Plan (If Needed)

If issues arise, you can quickly rollback:

### Rollback Workflow Only
```powershell
# Restore previous workflow version
gcloud workflows deploy story-generation \
  --source=workflows/story-generation.yaml.backup \
  --location=europe-west9
```

### Full Rollback
```powershell
# Find previous revision
gcloud run revisions list --service=story-generation-workflow --region=europe-west9

# Route traffic to previous revision
gcloud run services update-traffic story-generation-workflow \
  --to-revisions=<PREVIOUS_REVISION>=100 \
  --region=europe-west9
```

---

## 📝 Post-Deployment Validation

### Checklist

- [ ] Workflow executes without errors
- [ ] Retry logic activates for transient failures
- [ ] Safety blocks return 422 (not 500)
- [ ] Prompt rewrites are logged in token_usage_tracking
- [ ] Run statuses are correctly marked (`blocked` vs `failed`)
- [ ] No increase in error rates
- [ ] Cloud Run service is healthy

### Success Criteria

✅ **Workflow completes end-to-end** for a test story  
✅ **Transient errors retry automatically** (visible in logs)  
✅ **Safety blocks trigger prompt rewrite** (visible in logs + DB)  
✅ **No HTTP 500 "rethrow" errors** for safety blocks  
✅ **Token usage tracked** for `prompt_rewrite` action  

---

## 🆘 Troubleshooting

### Issue 1: Workflow Still Returns 500 for Safety Blocks

**Check**:
- Verify `/ai/image` route returns 422 (not 500) for safety blocks
- Check Cloud Run logs for the actual response code

**Fix**:
- Ensure latest container is deployed: `npm run deploy`
- Check `src/routes/ai.ts` line ~1170 for status code logic

### Issue 2: Prompt Rewrite Not Working

**Check**:
- Verify GenAI is accessible: `curl` test with GenAI API
- Check logs for "prompt rewrite" messages
- Verify template exists: `src/prompts/en-US/image-prompt-safety-rewrite.json`

**Debug**:
```powershell
npm run logs | Select-String "rewrite|GenAI"
```

### Issue 3: Retries Not Happening

**Check**:
- Verify workflow YAML deployed correctly
- Check for syntax errors in workflow

**Debug**:
```powershell
gcloud workflows describe story-generation --location=europe-west9
```

---

## 📞 Support

If you encounter issues:

1. **Check Logs First**: `npm run logs:tail`
2. **Review Database**: Check `story_generation_runs` table for error details
3. **Verify Workflow**: Ensure YAML is correctly deployed
4. **Test Locally**: Use `npm run dev` to test changes locally

---

## ✅ Sign-Off

**Deployed By**: _________________  
**Date**: _________________  
**Verified By**: _________________  
**Notes**: _________________

---

**Next Steps After Successful Deployment**:
1. Monitor logs for 24 hours
2. Review retry and safety block metrics
3. Gather user feedback on improved reliability
4. Consider adding dashboard metrics for retry success rates

# Check Workflows Database Connection and Token Usage Tracking
# This script comprehensively tests the workflows database connection

Write-Host "Checking Workflows Database Connection..." -ForegroundColor Yellow

# Load environment variables from .env.local and .env
if (Test-Path ".env.local") {
    Get-Content ".env.local" | ForEach-Object {
        if ($_ -match "^([^#][^=]+)=(.*)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
}

if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        if ($_ -match "^([^#][^=]+)=(.*)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
}

$env:PGPASSWORD = [System.Environment]::GetEnvironmentVariable("DB_PASSWORD")
$dbHost = [System.Environment]::GetEnvironmentVariable("DB_HOST")
$dbPort = [System.Environment]::GetEnvironmentVariable("DB_PORT")
$dbUser = [System.Environment]::GetEnvironmentVariable("DB_USER")
$workflowsDb = [System.Environment]::GetEnvironmentVariable("WORKFLOWS_DB")

Write-Host "Environment Variables:" -ForegroundColor Green
Write-Host "  DB_HOST: $dbHost" -ForegroundColor Cyan
Write-Host "  DB_PORT: $dbPort" -ForegroundColor Cyan
Write-Host "  DB_USER: $dbUser" -ForegroundColor Cyan
Write-Host "  WORKFLOWS_DB: $workflowsDb" -ForegroundColor Cyan

# Check if psql is available
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: psql command not found. Please install PostgreSQL client tools." -ForegroundColor Red
    Write-Host "Alternative: Use Node.js test instead..." -ForegroundColor Yellow
    
    # Test using Node.js instead
    Write-Host "`nTesting workflows database using Node.js..." -ForegroundColor Yellow
    
    # Build the project first
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Build failed" -ForegroundColor Red
        exit 1
    }
    
    # Create a test script
    $testScript = @"
import { getWorkflowsDatabase } from './dist/db/workflows-db.js';
import { sql } from 'drizzle-orm';

async function testWorkflowsDatabase() {
  try {
    console.log('Testing workflows database connection...');
    const db = getWorkflowsDatabase();
    
    // Test basic connection with timeout measurement
    const startTime = Date.now();
    const result = await db.execute(sql``SELECT 1 as test``);
    const responseTime = Date.now() - startTime;
    
    console.log('✅ Basic connection successful');
    console.log('⏱️ Response time:', responseTime, 'ms');
    
    if (responseTime > 2000) {
      console.log('⚠️ WARNING: Response time exceeds 2000ms (connection timeout threshold)');
    }
    
    // Test token_usage_tracking table exists
    const tableCheck = await db.execute(sql``
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'token_usage_tracking'
      ) as table_exists
    ``);
    
    console.log('Table check result:', tableCheck);
    
    // Check if the table exists - Drizzle returns Result object with rows array
    const tableExists = tableCheck.rows?.[0]?.table_exists === true;
    
    if (tableExists) {
      console.log('✅ token_usage_tracking table exists');
    } else {
      console.log('❌ token_usage_tracking table does not exist');
      console.log('Debug: tableCheck.rows[0] =', tableCheck.rows?.[0]);
      process.exit(1);
    }
    
    // Test table structure
    const columnsCheck = await db.execute(sql``
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'token_usage_tracking'
      ORDER BY column_name
    ``);
    
    console.log('📊 Table columns:');
    if (columnsCheck.rows) {
      columnsCheck.rows.forEach(col => {
        console.log(``  - ${col.column_name}: ${col.data_type}``);
      });
    } else {
      console.log('Columns result:', columnsCheck);
    }
    
    // Test read operations
    try {
      const countResult = await db.execute(sql``
        SELECT COUNT(*) as record_count 
        FROM token_usage_tracking
      ``);
      console.log('✅ Table is accessible for read operations');
      console.log('📊 Current records:', countResult.rows?.[0]?.record_count || countResult[0]?.record_count || 'unknown');
    } catch (error) {
      console.log('❌ Table read test failed:', error.message);
    }
    
    console.log('✅ All workflows database tests passed');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Workflows database test failed:');
    console.error('Error:', error.message);
    if (error.code) {
      console.error('Error code:', error.code);
    }
    if (error.message.includes('timeout')) {
      console.error('🕐 This appears to be a connection timeout issue');
      console.error('💡 Try increasing connectionTimeoutMillis in workflows-db.ts');
    }
    process.exit(1);
  }
}

testWorkflowsDatabase();
"@
    
    $testScript | Out-File -FilePath "test-workflows-db.mjs" -Encoding UTF8
    
    # Run the test
    node test-workflows-db.mjs
    $exitCode = $LASTEXITCODE
    
    # Clean up
    Remove-Item "test-workflows-db.mjs" -ErrorAction SilentlyContinue
    
    if ($exitCode -eq 0) {
        Write-Host "`nSUCCESS: Workflows database test completed successfully!" -ForegroundColor Green
    } else {
        Write-Host "`nERROR: Workflows database test failed!" -ForegroundColor Red
    }
    
    exit $exitCode
}

# Check if workflows_db exists
Write-Host "`nChecking if workflows database exists..." -ForegroundColor Yellow
$result = psql -h $dbHost -p $dbPort -U $dbUser -d postgres -t -c "SELECT 1 FROM pg_database WHERE datname = '$workflowsDb';"

if ($result -like "*1*") {
    Write-Host "SUCCESS: Workflows database '$workflowsDb' exists" -ForegroundColor Green
} else {
    Write-Host "ERROR: Workflows database '$workflowsDb' does not exist" -ForegroundColor Red
    exit 1
}

# Test connection to workflows database
Write-Host "`nTesting connection to workflows database..." -ForegroundColor Yellow
$connectionTest = psql -h $dbHost -p $dbPort -U $dbUser -d $workflowsDb -t -c "SELECT 1 as connection_test;"

if ($connectionTest -like "*1*") {
    Write-Host "SUCCESS: Connection to workflows database successful" -ForegroundColor Green
} else {
    Write-Host "ERROR: Failed to connect to workflows database" -ForegroundColor Red
    exit 1
}

# Check if token_usage_tracking table exists
Write-Host "`nChecking token_usage_tracking table..." -ForegroundColor Yellow
$tableCheck = psql -h $dbHost -p $dbPort -U $dbUser -d $workflowsDb -t -c "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'token_usage_tracking') as table_exists;"

if ($tableCheck -like "*t*") {
    Write-Host "SUCCESS: token_usage_tracking table exists" -ForegroundColor Green
} else {
    Write-Host "ERROR: token_usage_tracking table does not exist" -ForegroundColor Red
    exit 1
}

# Test table structure
Write-Host "`nChecking table structure..." -ForegroundColor Yellow
$columns = psql -h $dbHost -p $dbPort -U $dbUser -d $workflowsDb -t -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'token_usage_tracking' ORDER BY column_name;"
Write-Host "Table columns:" -ForegroundColor Cyan
Write-Host $columns

# Test insert permissions
Write-Host "`nTesting insert permissions..." -ForegroundColor Yellow
$insertTest = psql -h $dbHost -p $dbPort -U $dbUser -d $workflowsDb -t -c "SELECT has_table_privilege('$dbUser', 'token_usage_tracking', 'INSERT') as can_insert;"

if ($insertTest -like "*t*") {
    Write-Host "SUCCESS: User has INSERT permission on token_usage_tracking" -ForegroundColor Green
} else {
    Write-Host "ERROR: User does not have INSERT permission on token_usage_tracking" -ForegroundColor Red
}

# Test connection with timing
Write-Host "`nTesting connection timing..." -ForegroundColor Yellow
$startTime = Get-Date
$timingTest = psql -h $dbHost -p $dbPort -U $dbUser -d $workflowsDb -t -c "SELECT 'timing_test_passed' as result;"
$endTime = Get-Date
$responseTime = ($endTime - $startTime).TotalMilliseconds

Write-Host "Response time: $([math]::Round($responseTime, 2)) ms" -ForegroundColor Cyan

if ($responseTime -gt 2000) {
    Write-Host "WARNING: Response time exceeds 2000ms (connection timeout threshold)" -ForegroundColor Yellow
} else {
    Write-Host "SUCCESS: Response time is within acceptable range" -ForegroundColor Green
}

Write-Host "`nWorkflows database check completed!" -ForegroundColor Green

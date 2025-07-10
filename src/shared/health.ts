import { getDatabase } from '@/db/connection.js';
import { getWorkflowsDatabase } from '@/db/workflows-db.js';
import { logger } from '@/config/logger.js';
import { getDatabaseConfig } from '@/config/database.js';

export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  service: string;
  timestamp: string;
  environment: string;
  version: string;
  checks: {
    database: {
      status: 'healthy' | 'unhealthy';
      message: string;
      host: string;
      responseTime?: number;
    };
    workflowsDatabase: {
      status: 'healthy' | 'unhealthy';
      message: string;
      host: string;
      responseTime?: number;
    };
    internet: {
      status: 'healthy' | 'unhealthy';
      message: string;
      url: string;
      responseTime?: number;
      httpStatus?: number;
    };
  };
}

export class HealthService {
  private readonly serviceName = 'story-generation-workflow';
  private readonly version = '0.1.0';
  async checkHealth(environment: string): Promise<HealthStatus> {
    const timestamp = new Date().toISOString();
    
    // Check database health
    const databaseCheck = await this.checkDatabaseHealth();
    
    // Check workflows database health
    const workflowsDatabaseCheck = await this.checkWorkflowsDatabaseHealth();
    
    // Check internet connectivity
    const internetCheck = await this.checkInternetConnectivity();
    
    // Determine overall status
    const overallStatus = databaseCheck.status === 'healthy' && workflowsDatabaseCheck.status === 'healthy' && internetCheck.status === 'healthy' 
      ? 'healthy' 
      : (databaseCheck.status === 'healthy' || workflowsDatabaseCheck.status === 'healthy' || internetCheck.status === 'healthy') 
        ? 'degraded' 
        : 'unhealthy';
    
    return {
      status: overallStatus,
      service: this.serviceName,
      timestamp,
      environment,
      version: this.version,
      checks: {
        database: databaseCheck,
        workflowsDatabase: workflowsDatabaseCheck,
        internet: internetCheck
      }
    };
  }
  private async checkDatabaseHealth(): Promise<{
    status: 'healthy' | 'unhealthy';
    message: string;
    host: string;
    responseTime?: number;
  }> {
    const startTime = Date.now();
    const dbConfig = getDatabaseConfig();
    
    try {
      const db = getDatabase();
      
      // Execute a simple query to test connection
      await db.execute(sql`SELECT 1 as health_check`);
      
      const responseTime = Date.now() - startTime;
      
      logger.debug(`Database health check successful (${responseTime}ms)`);
      
      return {
        status: 'healthy',
        message: 'Database connection successful',
        host: dbConfig.host,
        responseTime
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown database error';
      
      logger.error(`Database health check failed (${responseTime}ms):`, error);
        return {
        status: 'unhealthy',
        message: `Database connection failed: ${errorMessage}`,
        host: dbConfig.host,
        responseTime
      };
    }
  }

  private async checkWorkflowsDatabaseHealth(): Promise<{
    status: 'healthy' | 'unhealthy';
    message: string;
    host: string;
    responseTime?: number;
  }> {
    const startTime = Date.now();
    const dbConfig = getDatabaseConfig();
    
    try {
      const db = getWorkflowsDatabase();
      
      // Execute a simple query to test connection
      await db.execute(sql`SELECT 1 as health_check`);
      
      const responseTime = Date.now() - startTime;
      
      logger.debug(`Workflows Database health check successful (${responseTime}ms)`);
      
      return {
        status: 'healthy',
        message: 'Workflows Database connection successful',
        host: dbConfig.host,
        responseTime
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown workflows database error';
      
      logger.error(`Workflows Database health check failed (${responseTime}ms):`, error);
        return {
        status: 'unhealthy',
        message: `Workflows Database connection failed: ${errorMessage}`,
        host: dbConfig.host,
        responseTime
      };
    }
  }

  /**
   * Check internet connectivity by attempting to reach a public website
   */
  private async checkInternetConnectivity(): Promise<{
    status: 'healthy' | 'unhealthy';
    message: string;
    url: string;
    responseTime?: number;
    httpStatus?: number;
  }> {
    const testUrl = 'https://www.google.com';
    const startTime = Date.now();
    
    try {
      // Use fetch with timeout to test internet connectivity
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
      
      const response = await fetch(testUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mythoria-HealthCheck/1.0'
        }
      });
      
      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;
      
      if (response.ok) {
        logger.debug(`Internet connectivity check successful (${responseTime}ms)`);
        
        return {
          status: 'healthy',
          message: 'Internet connectivity verified',
          url: testUrl,
          responseTime,
          httpStatus: response.status
        };
      } else {
        logger.warn(`Internet connectivity check failed with status ${response.status} (${responseTime}ms)`);
        
        return {
          status: 'unhealthy',
          message: `HTTP ${response.status} - ${response.statusText}`,
          url: testUrl,
          responseTime,
          httpStatus: response.status
        };
      }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      let errorMessage = 'Unknown error';
      
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          errorMessage = 'Request timeout (5s)';
        } else {
          errorMessage = error.message;
        }
      }
      
      logger.error(`Internet connectivity check failed (${responseTime}ms):`, error);
      
      return {
        status: 'unhealthy',
        message: `Internet connectivity failed: ${errorMessage}`,
        url: testUrl,
        responseTime
      };
    }
  }
}

// Import sql helper for raw queries
import { sql } from 'drizzle-orm';

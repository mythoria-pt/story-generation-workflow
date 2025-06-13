import request from 'supertest';
import { describe, it, expect, afterAll } from '@jest/globals';
import app from '../index.js';
import { closeDatabaseConnection } from '@/db/connection.js';

describe('Health API', () => {
  afterAll(async () => {
    await closeDatabaseConnection();
  });

  describe('GET /health', () => {
    it('should return health status with database check', async () => {
      const response = await request(app)
        .get('/health')
        .expect('Content-Type', /json/);

      // Response should be either 200 (healthy) or 503 (unhealthy)
      expect([200, 503]).toContain(response.status);      // Validate response structure
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('service', 'story-generation-workflow');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('environment');
      expect(response.body).toHaveProperty('version', '0.1.0');
      expect(response.body).toHaveProperty('checks');
      expect(response.body.checks).toHaveProperty('database');
      expect(response.body.checks).toHaveProperty('internet');        // Validate database check structure
      const dbCheck = response.body.checks.database;
      expect(dbCheck).toHaveProperty('status');
      expect(dbCheck).toHaveProperty('message');
      expect(dbCheck).toHaveProperty('host');
      expect(['healthy', 'unhealthy']).toContain(dbCheck.status);
      expect(typeof dbCheck.host).toBe('string');
      expect(dbCheck.host.length).toBeGreaterThan(0);
      
      // If database is healthy, response time should be present
      if (dbCheck.status === 'healthy') {
        expect(dbCheck).toHaveProperty('responseTime');
        expect(typeof dbCheck.responseTime).toBe('number');
        expect(dbCheck.responseTime).toBeGreaterThan(0);
      }

      // Validate internet check structure
      const internetCheck = response.body.checks.internet;
      expect(internetCheck).toHaveProperty('status');
      expect(internetCheck).toHaveProperty('message');
      expect(internetCheck).toHaveProperty('url');
      expect(['healthy', 'unhealthy']).toContain(internetCheck.status);
      expect(typeof internetCheck.url).toBe('string');
      expect(internetCheck.url.length).toBeGreaterThan(0);
      
      // If internet check is healthy, response time and HTTP status should be present
      if (internetCheck.status === 'healthy') {
        expect(internetCheck).toHaveProperty('responseTime');
        expect(internetCheck).toHaveProperty('httpStatus');
        expect(typeof internetCheck.responseTime).toBe('number');
        expect(typeof internetCheck.httpStatus).toBe('number');
        expect(internetCheck.responseTime).toBeGreaterThan(0);
        expect(internetCheck.httpStatus).toBe(200);
      }
    });    it('should return 200 status code when both database and internet are healthy', async () => {
      const response = await request(app)
        .get('/health')
        .expect('Content-Type', /json/);

      if (response.body.checks.database.status === 'healthy' && 
          response.body.checks.internet.status === 'healthy') {
        expect(response.status).toBe(200);
        expect(response.body.status).toBe('healthy');
      }
    });

    it('should return 503 status code when database is unhealthy', async () => {
      const response = await request(app)
        .get('/health')
        .expect('Content-Type', /json/);

      if (response.body.checks.database.status === 'unhealthy') {
        expect(response.status).toBe(503);
        expect(['unhealthy', 'degraded']).toContain(response.body.status);
      }
    });

    it('should return degraded status when only one check fails', async () => {
      const response = await request(app)
        .get('/health')
        .expect('Content-Type', /json/);

      // If one check is healthy and the other is unhealthy, status should be degraded
      const dbHealthy = response.body.checks.database.status === 'healthy';
      const internetHealthy = response.body.checks.internet.status === 'healthy';
      
      if ((dbHealthy && !internetHealthy) || (!dbHealthy && internetHealthy)) {
        expect(response.body.status).toBe('degraded');
        expect(response.status).toBe(503);
      }
    });

    it('should test internet connectivity with proper timeout', async () => {
      const response = await request(app)
        .get('/health')
        .expect('Content-Type', /json/);

      const internetCheck = response.body.checks.internet;
      
      // Internet check should complete within reasonable time (max 6 seconds including overhead)
      if (internetCheck.responseTime) {
        expect(internetCheck.responseTime).toBeLessThan(6000);
      }
    });

    it('should test internet connectivity against Google', async () => {
      const response = await request(app)
        .get('/health');

      const internetCheck = response.body.checks.internet;
      
      // Should test against Google's URL
      expect(internetCheck.url).toBe('https://www.google.com');
      
      // Message should be meaningful
      expect(typeof internetCheck.message).toBe('string');
      expect(internetCheck.message.length).toBeGreaterThan(0);
    });

    it('should return valid timestamp in ISO format', async () => {
      const response = await request(app)
        .get('/health');

      const timestamp = response.body.timestamp;
      expect(timestamp).toBeTruthy();
      
      // Validate ISO 8601 format
      const date = new Date(timestamp);
      expect(date.toISOString()).toBe(timestamp);
    });
  });
});

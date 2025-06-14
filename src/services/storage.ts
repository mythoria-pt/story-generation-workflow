/**
 * Storage Service
 * Handles file uploads to Google Cloud Storage
 */

import { Storage } from '@google-cloud/storage';
import { getEnvironment } from '@/config/environment.js';
import { logger } from '@/config/logger.js';

export class StorageService {
  private storage: Storage;
  private bucketName: string;

  constructor() {
    const env = getEnvironment();
    this.storage = new Storage({
      projectId: env.GOOGLE_CLOUD_PROJECT_ID
    });
    this.bucketName = env.STORAGE_BUCKET_NAME;
    
    logger.info('Storage Service initialized', {
      projectId: env.GOOGLE_CLOUD_PROJECT_ID,
      bucketName: this.bucketName
    });
  }

  /**
   * Upload a file to Google Cloud Storage
   */
  async uploadFile(filename: string, buffer: Buffer, contentType: string): Promise<string> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(filename);

      logger.debug('Uploading file to GCS', {
        filename,
        size: buffer.length,
        contentType
      });

      await file.save(buffer, {
        metadata: {
          contentType
        },
        public: true // Make files publicly accessible
      });

      // Return public URL
      const publicUrl = `https://storage.googleapis.com/${this.bucketName}/${filename}`;

      logger.info('File uploaded successfully', {
        filename,
        publicUrl,
        size: buffer.length
      });

      return publicUrl;
    } catch (error) {
      logger.error('Failed to upload file', {
        error: error instanceof Error ? error.message : String(error),
        filename,
        size: buffer.length
      });
      throw error;
    }
  }

  /**
   * Upload multiple files
   */
  async uploadFiles(files: Array<{ filename: string; buffer: Buffer; contentType: string }>): Promise<string[]> {
    try {
      const uploadPromises = files.map(file => 
        this.uploadFile(file.filename, file.buffer, file.contentType)
      );

      const urls = await Promise.all(uploadPromises);

      logger.info('Multiple files uploaded successfully', {
        count: files.length,
        urls
      });

      return urls;
    } catch (error) {
      logger.error('Failed to upload multiple files', {
        error: error instanceof Error ? error.message : String(error),
        fileCount: files.length
      });
      throw error;
    }
  }

  /**
   * Delete a file from storage
   */
  async deleteFile(filename: string): Promise<void> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(filename);

      await file.delete();

      logger.info('File deleted successfully', { filename });
    } catch (error) {
      logger.error('Failed to delete file', {
        error: error instanceof Error ? error.message : String(error),
        filename
      });
      throw error;
    }
  }

  /**
   * Check if a file exists
   */
  async fileExists(filename: string): Promise<boolean> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(filename);

      const [exists] = await file.exists();
      return exists;
    } catch (error) {
      logger.error('Failed to check file existence', {
        error: error instanceof Error ? error.message : String(error),
        filename
      });
      return false;
    }
  }
}

/**
 * Storage Service
 * Handles file uploads to Google Cloud Storage
 */

import { Storage } from '@google-cloud/storage';
import { getEnvironment } from '@/config/environment.js';
import { logger } from '@/config/logger.js';
import { handleGCSError, ErrorDetails } from '@/utils/errorHandling.js';

export class StorageService {
  private storage: Storage;
  private bucketName: string;

  constructor() {
    const env = getEnvironment();
    this.storage = new Storage({
      projectId: env.GOOGLE_CLOUD_PROJECT_ID,
    });
    this.bucketName = env.STORAGE_BUCKET_NAME;

    logger.info('Storage Service initialized', {
      projectId: env.GOOGLE_CLOUD_PROJECT_ID,
      bucketName: this.bucketName,
    });
  }

  /**
   * Generate a V4 signed URL for uploading a file directly to GCS
   */
  async generateSignedUploadUrl(
    filename: string,
    contentType: string,
    expiresInSeconds = 900,
  ): Promise<{ uploadUrl: string; publicUrl: string }> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(filename);

      const expires = Date.now() + expiresInSeconds * 1000;
      const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'write',
        contentType,
        expires,
      });

      const publicUrl = `https://storage.googleapis.com/${this.bucketName}/${filename}`;
      logger.info('Generated signed upload URL', { filename, expires });
      return { uploadUrl: url, publicUrl };
    } catch (error) {
      const errorDetails = handleGCSError(error, {
        filename,
        contentType,
        bucketName: this.bucketName,
        operation: 'generateSignedUploadUrl',
      });
      logger.error('Failed to generate signed upload URL', errorDetails);
      throw error;
    }
  }

  /**
   * Get file metadata (e.g., contentType, size) from GCS
   */
  async getFileMetadata(filename: string): Promise<{ contentType?: string; size?: number }> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(filename);
      const [exists] = await file.exists();
      if (!exists) {
        throw new Error(`File ${filename} does not exist in bucket ${this.bucketName}`);
      }
      const [metadata] = await file.getMetadata();
      const sizeStr = metadata.size as unknown as string | undefined;
      const result: { contentType?: string; size?: number } = {};
      if (typeof metadata.contentType === 'string') {
        result.contentType = metadata.contentType;
      }
      if (sizeStr) {
        const parsed = parseInt(sizeStr);
        if (!Number.isNaN(parsed)) result.size = parsed;
      }
      return result;
    } catch (error) {
      const errorDetails = handleGCSError(error, {
        filename,
        bucketName: this.bucketName,
        operation: 'getFileMetadata',
      });
      logger.error('Failed to get file metadata', errorDetails);
      throw error;
    }
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
        contentType,
      });
      await file.save(buffer, {
        metadata: {
          contentType,
        },
        // Removed 'public: true' to avoid ACL conflicts with uniform bucket-level access
        // Public access should be configured at the bucket level via IAM policies
      });

      // Return public URL
      const publicUrl = `https://storage.googleapis.com/${this.bucketName}/${filename}`;

      logger.info('File uploaded successfully', {
        filename,
        publicUrl,
        size: buffer.length,
      });

      return publicUrl;
    } catch (error) {
      // Enhanced error logging with GCS-specific handling
      const errorDetails = handleGCSError(error, {
        filename,
        size: buffer.length,
        contentType,
        bucketName: this.bucketName,
        operation: 'uploadFile',
      });

      logger.error('Failed to upload file', errorDetails);
      throw error;
    }
  }
  /**
   * Upload multiple files
   */
  async uploadFiles(
    files: Array<{ filename: string; buffer: Buffer; contentType: string }>,
  ): Promise<string[]> {
    try {
      const uploadPromises = files.map((file) =>
        this.uploadFile(file.filename, file.buffer, file.contentType),
      );

      const urls = await Promise.all(uploadPromises);

      logger.info('Multiple files uploaded successfully', {
        count: files.length,
        urls,
      });

      return urls;
    } catch (error) {
      const errorDetails = handleGCSError(error, {
        fileCount: files.length,
        filenames: files.map((f) => f.filename),
        totalSize: files.reduce((sum, f) => sum + f.buffer.length, 0),
        operation: 'uploadFiles',
      });

      logger.error('Failed to upload multiple files', errorDetails);
      throw error;
    }
  } /**
   * List files in a directory/prefix in the bucket
   */
  async listFiles(
    prefix?: string,
  ): Promise<Array<{ name: string; timeCreated?: string; size?: number }>> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const options = prefix ? { prefix } : {};
      const [files] = await bucket.getFiles(options);
      return files.map((file) => {
        const result: { name: string; timeCreated?: string; size?: number } = { name: file.name };
        if (file.metadata.timeCreated) result.timeCreated = file.metadata.timeCreated;
        if (file.metadata.size) {
          result.size =
            typeof file.metadata.size === 'string'
              ? parseInt(file.metadata.size)
              : file.metadata.size;
        }
        return result;
      });
    } catch (error) {
      const errorDetails = handleGCSError(error, {
        prefix,
        operation: 'listFiles',
      });

      logger.error('Failed to list files', errorDetails);
      throw error;
    }
  }

  /**
   * Get public URL for a file
   */
  async getPublicUrl(filename: string): Promise<string> {
    return `https://storage.googleapis.com/${this.bucketName}/${filename}`;
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
      const errorDetails = handleGCSError(error, {
        filename,
        operation: 'deleteFile',
      });

      logger.error('Failed to delete file', errorDetails);
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
      const errorDetails = handleGCSError(error, {
        filename,
        operation: 'fileExists',
      });

      logger.error('Failed to check file existence', errorDetails);
      return false;
    }
  }

  /**
   * Test storage configuration and permissions
   */
  async testConnection(): Promise<{
    success: boolean;
    details: Record<string, unknown> | ErrorDetails;
  }> {
    try {
      logger.info('Testing Google Cloud Storage connection', {
        bucketName: this.bucketName,
        projectId: this.storage.projectId,
      });

      const bucket = this.storage.bucket(this.bucketName);

      // Test 1: Check if bucket exists
      const [bucketExists] = await bucket.exists();
      if (!bucketExists) {
        return {
          success: false,
          details: {
            error: 'Bucket does not exist',
            bucketName: this.bucketName,
            suggestions: [
              'Verify STORAGE_BUCKET_NAME environment variable',
              'Ensure bucket exists in Google Cloud Console',
              'Check if bucket is in the correct project',
            ],
          },
        };
      }

      // Test 2: Try to get bucket metadata
      const [metadata] = await bucket.getMetadata();

      // Test 3: Try to upload a test file
      const testFileName = `test-connection-${Date.now()}.txt`;
      const testContent = Buffer.from('test connection file');

      await this.uploadFile(testFileName, testContent, 'text/plain');

      // Test 4: Try to delete the test file
      await this.deleteFile(testFileName);

      logger.info('Storage connection test successful', {
        bucketName: this.bucketName,
        location: metadata.location,
        storageClass: metadata.storageClass,
      });

      return {
        success: true,
        details: {
          bucketName: this.bucketName,
          projectId: this.storage.projectId,
          location: metadata.location,
          storageClass: metadata.storageClass,
          timeClass: metadata.timeCreated,
        },
      };
    } catch (error) {
      const errorDetails = handleGCSError(error, {
        bucketName: this.bucketName,
        operation: 'testConnection',
      });

      logger.error('Storage connection test failed', errorDetails);

      return {
        success: false,
        details: errorDetails,
      };
    }
  }

  /**
   * Make a file publicly accessible (works with uniform bucket-level access)
   */
  async makeFilePublic(filename: string): Promise<void> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(filename);

      // With uniform bucket-level access enabled, we use IAM policies instead of ACLs
      await file.makePublic();

      logger.debug('File made public via IAM policy', { filename });
    } catch (error) {
      const errorDetails = handleGCSError(error, {
        filename,
        operation: 'makeFilePublic',
      });

      logger.error('Failed to make file public', errorDetails);
      throw error;
    }
  }

  /**
   * Get bucket configuration and provide setup recommendations
   */
  async getBucketInfo(): Promise<{ config: Record<string, unknown>; recommendations: string[] }> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const [metadata] = await bucket.getMetadata();
      const [iam] = await bucket.iam.getPolicy();

      const recommendations: string[] = []; // Check if uniform bucket-level access is enabled
      const uniformAccess = metadata.uniformBucketLevelAccess as { enabled?: boolean } | undefined;
      if (uniformAccess?.enabled) {
        recommendations.push(
          '✅ Uniform bucket-level access is enabled (recommended for security)',
        );
        recommendations.push(
          'ℹ️  To make files publicly accessible, configure IAM policy at bucket level:',
        );
        recommendations.push('   - Add "allUsers" member with "Storage Object Viewer" role');
        recommendations.push(
          '   - Or use gsutil: gsutil iam ch allUsers:objectViewer gs://' + this.bucketName,
        );
      } else {
        recommendations.push('⚠️  Legacy ACL access is enabled');
        recommendations.push(
          '💡 Consider enabling uniform bucket-level access for better security',
        );
      }

      // Check public access
      const hasPublicAccess = iam.bindings?.some(
        (binding) =>
          binding.members?.includes('allUsers') && binding.role === 'roles/storage.objectViewer',
      );

      if (hasPublicAccess) {
        recommendations.push('✅ Bucket is configured for public read access');
      } else {
        recommendations.push('⚠️  Bucket is not configured for public access');
        recommendations.push('💡 To allow public access to uploaded images:');
        recommendations.push(
          '   gcloud storage buckets add-iam-policy-binding gs://' +
            this.bucketName +
            ' --member=allUsers --role=roles/storage.objectViewer',
        );
      }

      return {
        config: {
          name: metadata.name,
          location: metadata.location,
          storageClass: metadata.storageClass,
          uniformBucketLevelAccess: metadata.uniformBucketLevelAccess,
          publicAccessPrevention: metadata.publicAccessPrevention,
          hasPublicAccess,
        },
        recommendations,
      };
    } catch (error) {
      const errorDetails = handleGCSError(error, {
        bucketName: this.bucketName,
        operation: 'getBucketInfo',
      });

      logger.error('Failed to get bucket info', errorDetails);
      throw error;
    }
  }

  /**
   * Download file content from Google Cloud Storage
   */
  async downloadFile(filename: string): Promise<string> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(filename);

      logger.debug('Downloading file from GCS', {
        filename,
        bucketName: this.bucketName,
      });

      const [exists] = await file.exists();
      if (!exists) {
        throw new Error(`File ${filename} does not exist in bucket ${this.bucketName}`);
      }

      const [contents] = await file.download();
      const fileContent = contents.toString('utf-8');

      logger.info('File downloaded successfully', {
        filename,
        size: contents.length,
      });

      return fileContent;
    } catch (error) {
      const errorDetails = handleGCSError(error, {
        filename,
        bucketName: this.bucketName,
        operation: 'downloadFile',
      });

      logger.error('Failed to download file', errorDetails);
      throw error;
    }
  }

  /**
   * Download file content as Buffer from Google Cloud Storage (for images)
   */
  async downloadFileAsBuffer(filename: string): Promise<Buffer> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(filename);

      logger.debug('Downloading file as buffer from GCS', {
        filename,
        bucketName: this.bucketName,
      });

      const [exists] = await file.exists();
      if (!exists) {
        throw new Error(`File ${filename} does not exist in bucket ${this.bucketName}`);
      }

      const [contents] = await file.download();

      logger.info('File downloaded as buffer successfully', {
        filename,
        size: contents.length,
      });

      return contents;
    } catch (error) {
      const errorDetails = handleGCSError(error, {
        filename,
        bucketName: this.bucketName,
        operation: 'downloadFileAsBuffer',
      });

      logger.error('Failed to download file as buffer', errorDetails);
      throw error;
    }
  }
}

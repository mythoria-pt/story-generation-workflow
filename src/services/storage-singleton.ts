/**
 * Lazy singleton for StorageService
 */
import { StorageService } from '@/services/storage.js';

let _storageSingleton: StorageService | null = null;

export function getStorageService(): StorageService {
  if (!_storageSingleton) {
    _storageSingleton = new StorageService();
  }
  return _storageSingleton;
}

// Test-only helper to reset the singleton between tests
export function resetStorageForTests(): void {
  _storageSingleton = null;
}

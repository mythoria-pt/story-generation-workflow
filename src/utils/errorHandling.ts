/**
 * Error utilities for better error handling and debugging
 */

export interface ErrorDetails {
  message: string;
  stack?: string;
  name?: string;
  code?: string;
  status?: number;
  details?: unknown; // Can contain various error details from different sources
  timestamp: string;
}

/**
 * Serialize an error object to a plain object with all relevant details
 */
export function serializeError(error: unknown): ErrorDetails {
  const timestamp = new Date().toISOString();
    if (error instanceof Error) {
    const details: ErrorDetails = {
      message: error.message,
      name: error.name,
      timestamp
    };

    if (error.stack) {
      details.stack = error.stack;
    }

    // Handle Google Cloud Storage specific errors
    if ('code' in error) {
      details.code = String((error as any).code);
    }
    
    if ('status' in error) {
      details.status = Number((error as any).status);
    }

    // Include additional properties that might be on the error object
  const errorKeys = Object.getOwnPropertyNames(error);
  const additionalProps: Record<string, any> = {};
    
    for (const key of errorKeys) {
      if (!['message', 'name', 'stack'].includes(key)) {
        try {
          const value = (error as any)[key];
          // Only include serializable values
          if (typeof value !== 'function' && typeof value !== 'symbol') {
            additionalProps[key] = value;
          }
        } catch {
          // Ignore properties that can't be accessed
        }
      }
    }
    
    if (Object.keys(additionalProps).length > 0) {
      details.details = additionalProps;
    }

    return details;
  }
  
  // Handle non-Error objects
  return {
    message: String(error),
    name: 'UnknownError',
    timestamp,
    details: {
      originalType: typeof error,
      originalValue: error
    }
  };
}

/**
 * Create a Google Cloud Storage specific error handler
 */
export function handleGCSError(error: unknown, context: Record<string, any> = {}): ErrorDetails {
  const serialized = serializeError(error);
  
  return {
    ...serialized,
    details: {
      ...(serialized.details && typeof serialized.details === 'object' ? serialized.details : {}),
      context,
      // Common GCS error scenarios
      troubleshooting: getGCSTroubleshootingHints(serialized)
    }
  };
}

/**
 * Provide troubleshooting hints based on error patterns
 */
function getGCSTroubleshootingHints(error: ErrorDetails): string[] {
  const hints: string[] = [];
  
  if (error.code === '403' || error.message.includes('permission') || error.message.includes('forbidden')) {
    hints.push('Check Google Cloud Storage bucket permissions');
    hints.push('Verify service account has Storage Object Admin role');
    hints.push('Ensure bucket exists and is accessible');
  }
  
  if (error.code === '404' || error.message.includes('not found')) {
    hints.push('Verify bucket name is correct');
    hints.push('Check if bucket exists in the specified project');
  }
  
  if (error.message.includes('quota') || error.message.includes('rate limit')) {
    hints.push('Check Google Cloud Storage quotas and limits');
    hints.push('Implement retry logic with exponential backoff');
  }
  
  if (error.message.includes('network') || error.message.includes('timeout')) {
    hints.push('Check network connectivity');
    hints.push('Verify Google Cloud project configuration');
  }

  if (error.message.includes('authentication')) {
    hints.push('Check Google Cloud credentials configuration');
    hints.push('Verify GOOGLE_APPLICATION_CREDENTIALS or service account key');
  }
  
  return hints;
}

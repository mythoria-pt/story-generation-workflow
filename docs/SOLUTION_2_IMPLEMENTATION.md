# API Update: Image Editing with Original URI Parameter

## Summary
Successfully implemented Solution 2 - modified all image editing endpoints to accept the original image URI directly in the request body instead of extracting it from the database. This approach is simpler, more reliable, and eliminates URI parsing complexity.

## Changes Made

### 1. Updated API Schema
**File: `src/routes/image-edit.ts`**

**Before:**
```typescript
const ImageEditRequestSchema = z.object({
  userRequest: z.string().min(1).max(2000)
});
```

**After:**
```typescript
const ImageEditRequestSchema = z.object({
  userRequest: z.string().min(1).max(2000),
  originalImageUri: z.string().url('Valid image URI is required'),
  graphicalStyle: z.string().optional()
});
```

### 2. Updated All Three Endpoints

#### Front Cover Editing: `PATCH /stories/:storyId/images/front-cover`
- **Removed**: Database lookup for `story.coverUri`
- **Added**: Direct use of `originalImageUri` from request body
- **Added**: Optional `graphicalStyle` parameter support
- **Simplified**: No need to check if story has a cover URI

#### Back Cover Editing: `PATCH /stories/:storyId/images/back-cover`
- **Removed**: Database lookup for `story.backcoverUri`
- **Added**: Direct use of `originalImageUri` from request body
- **Added**: Optional `graphicalStyle` parameter support
- **Simplified**: No need to check if story has a back cover URI

#### Chapter Image Editing: `PATCH /stories/:storyId/chapters/:chapterNumber/image`
- **Removed**: Database lookup for `targetChapter.imageUri`
- **Added**: Direct use of `originalImageUri` from request body
- **Added**: Optional `graphicalStyle` parameter support
- **Simplified**: No need to check if chapter has an image URI

### 3. Cleaned Up Utilities
**File: `src/utils/imageUtils.ts`**

**Removed unused functions:**
- `getFilePathFromUri()` - No longer needed since we use the URI directly

**Kept essential functions:**
- `extractFilenameFromUri()` - Still needed for extracting the path structure for Google Cloud Storage
- `generateNextVersionFilename()` - Still needed for version increment
- `buildImageEditPrompt()` - Still needed for prompt structure
- `getImageDimensions()` - Still needed for environment-based sizing

**Updated `extractFilenameFromUri()`:**
- Now handles the full file path extraction that `getFilePathFromUri()` was doing
- Simplified logic with better fallback handling

## New API Request Format

### Before (Original Implementation):
```json
POST /stories/{storyId}/images/front-cover
{
  "userRequest": "Remove the men and woman from the drawing"
}
```

### After (New Implementation):
```json
POST /stories/{storyId}/images/front-cover
{
  "userRequest": "Remove the men and woman from the drawing",
  "originalImageUri": "https://storage.googleapis.com/mythoria-generated-stories/f2938a4b-68a3-43c9-a120-d5d4fbbd2f71/images/chapter_1_v001.jpg",
  "graphicalStyle": "artistic"
}
```

## Benefits Achieved

### ✅ **Solved Original Issue**
- No more "File does not exist" errors
- Eliminates URI parsing complexity and edge cases
- Direct and explicit about which image to edit

### ✅ **Improved Reliability**
- No database dependency for image URI lookup
- Works with any valid image URI format
- Eliminates potential database/storage inconsistencies

### ✅ **Enhanced Flexibility**
- Can edit any image, not just database-stored ones
- Easy to implement batch operations
- Supports external image editing scenarios

### ✅ **Better Performance**
- Eliminates unnecessary database queries
- Faster response times
- Reduced database load

### ✅ **Cleaner Architecture**
- Simpler code paths
- Better separation of concerns
- Easier to test and maintain

## Client Migration Required

**Important:** This is a breaking change. Clients need to be updated to include the `originalImageUri` in their requests.

### Migration Steps:
1. **Update client requests** to include `originalImageUri` field
2. **Add optional `graphicalStyle`** parameter if needed
3. **Test with existing image URIs** to ensure compatibility
4. **Remove old database URI lookup logic** from client side if any

### Example Client Update:
```javascript
// Before
const response = await fetch(`/stories/${storyId}/images/front-cover`, {
  method: 'PATCH',
  body: JSON.stringify({
    userRequest: "Remove the background"
  })
});

// After
const response = await fetch(`/stories/${storyId}/images/front-cover`, {
  method: 'PATCH',
  body: JSON.stringify({
    userRequest: "Remove the background",
    originalImageUri: currentImageUri, // Client now provides this
    graphicalStyle: "realistic" // Optional
  })
});
```

## API Response Changes

The response format remains the same, but now includes the provided `originalImageUri` in metadata:

```json
{
  "success": true,
  "storyId": "f2938a4b-68a3-43c9-a120-d5d4fbbd2f71",
  "imageType": "front_cover",
  "newImageUrl": "https://storage.googleapis.com/mythoria-generated-stories/...",
  "metadata": {
    "originalUri": "https://storage.googleapis.com/mythoria-generated-stories/...", // Now from request
    "filename": "frontcover_v002.jpg",
    "size": 1250000,
    "timestamp": "2025-07-14T...",
    "userRequest": "Remove the men and woman from the drawing",
    "dimensions": { "width": 1024, "height": 1536 }
  }
}
```

## Testing Recommendations

1. **Test with different URI formats:**
   - Full HTTPS URLs: `https://storage.googleapis.com/bucket/path/file.jpg`
   - GS URLs: `gs://bucket/path/file.jpg`
   - Relative paths: `path/to/file.jpg`

2. **Test error scenarios:**
   - Invalid URIs
   - Non-existent files
   - Malformed requests

3. **Test style integration:**
   - With `graphicalStyle` parameter
   - Without `graphicalStyle` parameter
   - Invalid style names

## Conclusion

The API is now simpler, more reliable, and eliminates the complex URI parsing that was causing the original error. Clients will need to update their requests to include the `originalImageUri`, but this change provides much better long-term maintainability and flexibility.

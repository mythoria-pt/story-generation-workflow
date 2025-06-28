# Image Edit API Endpoint

## Overview
The Image Edit endpoint allows users to request AI-powered edits to existing story images. The system can modify images based on natural language requests while maintaining artistic style, quality, and story coherence.

## Endpoint

### POST /image-edit

Edit an existing story image using AI.

#### Request Body
```json
{
  "storyId": "uuid",
  "imageUrl": "gs://bucket/path/to/image.png",
  "userRequest": "string"
}
```

#### Parameters
- **storyId** (required): UUID of the story that contains the image
- **imageUrl** (required): Google Cloud Storage URL of the image to edit (gs:// or https://storage.googleapis.com/ format)
- **userRequest** (required): Natural language description of the desired changes (1-2000 characters)

#### Response

##### Success Response (200)
```json
{
  "success": true,
  "storyId": "uuid",
  "originalImageUrl": "gs://bucket/path/to/original_image.png",
  "newImageUrl": "https://storage.googleapis.com/bucket/path/to/image_v2_2025-06-20T10-56-09-584Z.png",
  "userRequest": "string",
  "metadata": {
    "originalImageSize": 1024000,
    "editedImageSize": 1100000,
    "filename": "chapter_1_v2_2025-06-20T10-56-09-584Z.png",
    "timestamp": "2025-06-20T10:56:09.584Z"
  }
}
```

##### Error Responses

**404 - Story Not Found**
```json
{
  "success": false,
  "error": "Story not found"
}
```

**404 - Image Not Found**
```json
{
  "success": false,
  "error": "Image not found in storage"
}
```

**404 - Image Access Error**
```json
{
  "success": false,
  "error": "Could not access original image from storage"
}
```

**400 - Validation Error**
```json
{
  "success": false,
  "error": "Validation failed",
  "details": [
    {
      "field": "imageUrl",
      "message": "Image URL must be a Google Cloud Storage URL (gs:// or https://storage.googleapis.com/)"
    }
  ]
}
```

**500 - Server Error**
```json
{
  "success": false,
  "error": "Image editing failed"
}
```

## Usage Examples

### Basic Image Edit
Edit an existing story image to change specific elements:

```bash
curl -X POST http://localhost:8080/image-edit \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": "123e4567-e89b-12d3-a456-426614174000",
    "imageUrl": "gs://mythoria-storage/stories/123e4567-e89b-12d3-a456-426614174000/chapter_1.png",
    "userRequest": "Change the dragon from red to blue and add more clouds in the sky"
  }'
```

### Character Modification
Modify character appearance in an existing illustration:

```bash
curl -X POST http://localhost:8080/image-edit \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": "123e4567-e89b-12d3-a456-426614174000",
    "imageUrl": "gs://mythoria-storage/stories/123e4567-e89b-12d3-a456-426614174000/chapter_2.png",
    "userRequest": "Make the protagonist wear a golden crown and hold a magic staff"
  }'
```

### Environmental Changes
Modify the setting or background of an image:

```bash
curl -X POST http://localhost:8080/image-edit \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": "123e4567-e89b-12d3-a456-426614174000",
    "imageUrl": "gs://mythoria-storage/stories/123e4567-e89b-12d3-a456-426614174000/chapter_3.png",
    "userRequest": "Change the forest background to a snowy mountain landscape"
  }'
```

## Technical Details

### Image Processing
- **Input Format**: Supports images in PNG, JPEG, and other common formats
- **Output Format**: Generated images are saved as PNG files
- **Resolution**: Maintains original resolution, default 1024x1024 for new generations
- **Quality**: Uses standard quality settings optimized for story illustrations

### File Naming Convention
The service automatically generates versioned filenames for edited images:
- **Original**: `chapter_1.png`
- **First Edit**: `chapter_1_v2_2025-06-20T10-56-09-584Z.png`
- **Second Edit**: `chapter_1_v3_2025-06-20T11-15-23-123Z.png`

### AI Provider
The endpoint uses the configured `IMAGE_PROVIDER` from environment variables:
- Currently supports OpenAI's image generation models
- Can be extended to support additional providers (Google Vertex AI, etc.)

### System Prompt
The AI uses a specialized system prompt that:
- Emphasizes maintaining original artistic style and quality
- Preserves story context and character consistency
- Focuses on making only requested modifications
- Ensures professional illustration standards

## Error Handling

### Common Issues
1. **Invalid Image URL**: Ensure the URL is a valid Google Cloud Storage URL
2. **Image Not Found**: Verify the image exists in storage and is accessible
3. **Story Not Found**: Confirm the storyId exists in the database
4. **Request Too Long**: Keep user requests under 2000 characters
5. **AI Generation Failure**: May occur due to API limits or invalid prompts

### Retry Logic
- The service includes built-in retry logic for transient failures
- Network timeouts are handled gracefully
- Storage upload failures are automatically retried

## Security Considerations
- Only processes images from the configured Google Cloud Storage bucket
- Validates story ownership through the story service
- Sanitizes user input to prevent prompt injection
- Logs all operations for audit purposes

## Performance Notes
- Image editing typically takes 10-30 seconds depending on complexity
- Large images may take longer to process
- The service is designed to handle concurrent requests efficiently
- Generated images are immediately available via public URLs

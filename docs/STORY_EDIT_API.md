# Story Edit API Endpoint

## Overview
The Story Edit endpoint allows users to request AI-powered edits to existing published stories. The system can edit either specific chapters or the entire story based on user requests while maintaining story consistency and style.

## Endpoint

### POST /story-edit

Edit an existing published story using AI.

#### Request Body
```json
{
  "storyId": "uuid",
  "chapterNumber": 3,          // Optional - if omitted, edits entire story
  "userRequest": "string"      // The editing request (1-2000 characters)
}
```

#### Parameters
- **storyId** (required): UUID of the story to edit
- **chapterNumber** (optional): Specific chapter number to edit. If omitted, the entire story will be processed
- **userRequest** (required): Natural language description of the desired changes (1-2000 characters)

#### Response

##### Success Response (200)
```json
{
  "success": true,
  "storyId": "uuid",
  "chapterNumber": 3,          // Present if specific chapter was edited
  "context": "Chapter 3",      // Description of what was edited
  "userRequest": "string",     // Original user request
  "updatedHtml": "string",     // Complete updated HTML story
  "metadata": {
    "originalLength": 1500,    // Length of original text
    "editedLength": 1620,      // Length of edited text
    "htmlLength": 8940,        // Length of final HTML
    "timestamp": "2025-06-20T10:30:00.000Z"
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

**404 - HTML Not Found**
```json
{
  "success": false,
  "error": "Story HTML not found in storage"
}
```

**400 - Story Not Published**
```json
{
  "success": false,
  "error": "Story must be in published state to edit"
}
```

**404 - Chapter Not Found**
```json
{
  "success": false,
  "error": "Chapter 3 not found in story"
}
```

**400 - Validation Error**
```json
{
  "success": false,
  "error": "Validation failed",
  "details": [
    {
      "field": "userRequest",
      "message": "String must contain at least 1 character(s)"
    }
  ]
}
```

**500 - Server Error**
```json
{
  "success": false,
  "error": "Story editing failed"
}
```

## Functionality

### 1. Story Validation
- Checks if story exists in the database
- Verifies story is in "published" state
- Validates story has HTML content in storage

### 2. Content Extraction
- **Full Story**: Extracts all story content from HTML
- **Specific Chapter**: Extracts content from the specified chapter number
- Uses HTML parsing to identify chapter boundaries (looks for `<h2>Chapter N</h2>` patterns)

### 3. AI Processing
- Creates context-aware prompt with story metadata
- Includes user's editing request
- Maintains story's original style, genre, and target audience
- Uses the configured AI text provider (Google GenAI, OpenAI, etc.)

### 4. Content Merging
- **Chapter Edit**: Merges edited chapter back into full story HTML
- **Full Story Edit**: Replaces entire story content while preserving HTML structure
- Returns complete updated HTML document

## Usage Examples

### Edit a Specific Chapter
```bash
curl -X POST http://localhost:3000/story-edit \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": "550e8400-e29b-41d4-a716-446655440000",
    "chapterNumber": 2,
    "userRequest": "Make the dragon more friendly and less scary for young children"
  }'
```

### Edit Entire Story
```bash
curl -X POST http://localhost:3000/story-edit \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": "550e8400-e29b-41d4-a716-446655440000",
    "userRequest": "Add more dialogue between the main character and their pet companion throughout the story"
  }'
```

## Technical Details

### AI Context Preservation
- Maintains story's original style and voice
- Preserves character consistency
- Respects target audience and genre constraints
- Includes full story context in AI prompt

### HTML Processing
- Safely extracts text content from HTML
- Preserves story structure and formatting
- Handles various chapter heading formats
- Maintains HTML document integrity

### Storage Integration
- Downloads story HTML from Google Cloud Storage
- Handles file access errors gracefully
- Supports various storage URI formats

### Error Handling
- Comprehensive validation of input parameters
- Graceful handling of missing stories/chapters
- Detailed error logging for debugging
- User-friendly error messages

## Security Considerations

- Validates story ownership (through author context)
- Limits user request length to prevent abuse
- Only processes published stories
- Logs all editing requests for audit purposes

## Performance Notes

- Processing time varies based on story length and complexity
- Typical response time: 5-15 seconds for chapter edits, 30-60 seconds for full story edits
- AI token usage tracked for billing and monitoring
- Implements retry logic for transient failures

## Integration

This endpoint integrates with:
- **Story Service**: Database operations for story metadata
- **Storage Service**: File operations with Google Cloud Storage
- **AI Gateway**: Text generation using configured providers
- **Prompt Service**: Template-based prompt generation
- **Token Tracking**: Usage monitoring and billing

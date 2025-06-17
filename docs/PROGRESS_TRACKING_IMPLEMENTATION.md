# Story Generation Progress Tracking Implementation

## Overview

The Story Generation Progress Tracking system provides accurate real-time progress updates for the UI by calculating completion percentages based on workflow steps and their estimated execution times.

## Implementation

### Core Service: `ProgressTrackerService`

**Location**: `src/services/progress-tracker.ts`

The service tracks progress by:
1. Analyzing completed workflow steps
2. Calculating elapsed time based on step-specific time estimates
3. Updating the `storyGenerationCompletedPercentage` field in the stories table

### Workflow Steps & Time Estimates

| Step (codename)        | Estimated Time | Per Chapter | Notes                                 |
| ---------------------- | -------------- | ----------- | ------------------------------------- |
| `generate_outline`     | 15s           | No          | Initial story structure               |
| `write_chapters`       | 25s           | Yes         | Per individual chapter (write_chapter_N) |
| `generate_front_cover` | 60s           | No          | Front cover image generation          |
| `generate_back_cover`  | 60s           | No          | Back cover image generation           |
| `generate_images`      | 30s           | Yes         | Chapter illustration images           |
| `assemble`             | 10s           | No          | Story assembly and formatting         |
| `generate_audiobook`   | 20s           | No          | TTS audio generation                  |
| `done`                 | 1s            | No          | Final status update                   |

### Key Features

#### 1. Dynamic Chapter Count Detection
- Extracts chapter count from the generated outline
- Fallback to 4 chapters if detection fails
- Supports variable chapter count per story

#### 2. Individual Chapter Step Handling
- Maps `write_chapter_N` steps to the `write_chapters` workflow step
- Accounts for each completed chapter individually
- Provides accurate progress during chapter generation

#### 3. Progress Calculation Algorithm
```typescript
completedPercentage = (elapsedTime / totalEstimatedTime) * 100
```

Where:
- `elapsedTime` = sum of time for all completed steps
- `totalEstimatedTime` = sum of all workflow steps (accounting for chapter count)

#### 4. Real-time Updates
- Automatically triggered on every internal API call
- Updates `stories.storyGenerationCompletedPercentage` field
- Non-blocking progress updates (errors don't fail the main operation)

## API Integration

### Automatic Progress Updates

The progress tracker is integrated into the internal API endpoints:

#### 1. Run Status Updates
**Endpoint**: `PATCH /internal/runs/:runId`
- Triggers progress update after every run status change
- Updates when workflow steps transition between states

#### 2. Outline Storage
**Endpoint**: `POST /internal/runs/:runId/outline`
- Updates progress after outline completion
- Uses outline data to determine chapter count for future calculations

#### 3. Chapter Storage
**Endpoint**: `POST /internal/runs/:runId/chapter/:chapterNumber`
- Updates progress after each chapter completion
- Provides incremental progress during the longest workflow phase

## Database Schema

### Updated Stories Table
```sql
ALTER TABLE stories ADD COLUMN IF NOT EXISTS 
  story_generation_completed_percentage INTEGER DEFAULT 0;
```

The `storyGenerationCompletedPercentage` field stores the current completion percentage (0-100).

## Usage Examples

### Example Progress Calculation

For a 3-chapter story:

**Total Estimated Time**: 15 + (25×3) + 60 + 60 + (30×3) + 10 + 20 + 1 = 241 seconds

**Progress After Each Step**:
- After outline: 15/241 = 6%
- After chapter 1: 40/241 = 17%
- After chapter 2: 65/241 = 27%
- After chapter 3: 90/241 = 37%
- After front cover: 150/241 = 62%
- After back cover: 210/241 = 87%
- After images (all): 300/241 = 100% (capped)

### Step-by-Step Progress Example
```typescript
// Example workflow progression
const progressUpdates = [
  { step: 'generate_outline', percentage: 6 },
  { step: 'write_chapter_1', percentage: 17 },
  { step: 'write_chapter_2', percentage: 27 },
  { step: 'write_chapter_3', percentage: 37 },
  { step: 'generate_front_cover', percentage: 62 },
  { step: 'generate_back_cover', percentage: 87 },
  { step: 'generate_images', percentage: 100 },
  { step: 'assemble', percentage: 100 },
  { step: 'generate_audiobook', percentage: 100 },
  { step: 'done', percentage: 100 }
];
```

## Error Handling

### Graceful Degradation
- Progress update failures don't interrupt the main workflow
- Logs warnings for debugging but continues processing
- Provides default values when data is unavailable

### Fallback Scenarios
- Uses default 4-chapter estimate when outline parsing fails
- Continues with partial progress data if some steps are missing
- Handles malformed step data gracefully

## Performance Considerations

### Efficient Calculations
- Minimal database queries (uses existing step data)
- Cached chapter count extraction from outline
- Lightweight progress calculations

### Non-blocking Updates
- Progress updates run asynchronously
- Don't block main workflow execution
- Fail gracefully without impacting story generation

## Monitoring & Debugging

### Log Events
- Progress calculation details
- Chapter count detection results
- Update success/failure notifications
- Performance timing information

### Debug Information
```typescript
{
  runId: string,
  completedPercentage: number,
  totalEstimatedTime: number,
  elapsedTime: number,
  remainingTime: number,
  currentStep: string,
  completedSteps: string[],
  totalSteps: number
}
```

## Future Enhancements

### Potential Improvements
1. **Machine Learning**: Learn from actual execution times to improve estimates
2. **Real-time Step Progress**: Track progress within individual steps
3. **User Feedback**: Allow users to see detailed step-by-step progress
4. **Analytics**: Track average completion times for system optimization
5. **Priority Queuing**: Use progress data for resource allocation

### Additional Features
- Progress history tracking
- Time-to-completion estimates
- Performance benchmarking
- Progress-based notifications

## Testing

### Unit Test Coverage
- Progress calculation accuracy
- Chapter count detection
- Error handling scenarios
- Database update operations

### Integration Testing
- End-to-end workflow progress tracking
- API endpoint integration
- Database consistency validation
- Performance under load

## Conclusion

The Story Generation Progress Tracking system provides accurate, real-time progress updates that enhance the user experience by giving clear visibility into the story generation process. The implementation is robust, efficient, and designed to handle the dynamic nature of the story generation workflow while maintaining high performance and reliability.

# Page Estimation System

## Overview

The page estimation system ensures that chapter images always appear on even (left) pages and chapter content starts on odd (right) pages, while minimizing unnecessary blank pages.

## How It Works

### Character Capacity by Target Audience

The system uses empirically measured character capacities for each target audience:

| Target Audience | First Page | Full Pages | Font Size |
|-----------------|------------|------------|-----------|
| children-0-2    | 400 chars | 600 chars | 20pt      |
| children-3-6    | 565 chars | 800 chars | 18pt      |
| children-7-10   | 1030 chars| 1300 chars| 14pt      |
| children-11-14  | 1255 chars| 1657 chars| 12pt      |
| young-adult-15-17| 1480 chars| 2014 chars| 11pt      |
| adult-18-plus   | 1860 chars| 2270 chars| 10pt      |
| all-ages        | 1480 chars| 2014 chars| 11pt      |

### Page Layout Logic

1. **Initial Pages**: The book starts with 5 fixed pages:
   - Page 1: Title
   - Page 2: Copyright/Technical Info
   - Page 3: Dedication
   - Page 4: Synopsis
   - Page 5: Table of Contents

2. **Chapter Layout**: Starting from page 6 (even), for each chapter:
   - If current page is odd, insert a blank page
   - Place chapter image on even page (left side)
   - Place chapter content starting on odd page (right side)
   - Estimate content pages using character count and target audience

3. **Blank Page Insertion**: Blank pages are only inserted when necessary to maintain the even/odd structure.

## Key Functions

### `estimateChapterPages(content, targetAudience)`
- Strips HTML tags from content
- Counts plain text characters
- Calculates pages needed based on target audience capacity
- Always rounds up to ensure content fits

### `calculateChapterLayout(chapters, targetAudience)`
- Calculates complete layout for all chapters
- Determines when blank pages are needed
- Returns detailed layout information including page numbers

### Example Output

For a story with 3 chapters targeting `children-3-6`:
```
=== Page Layout Debug (Target: children-3-6) ===
Initial pages: 1-5 (title, copyright, dedication, synopsis, TOC)

Chapter 1:
  - Image page: 6 (EVEN)
  - Content pages: 7-8 (2 pages)

Chapter 2:
  - Blank page: 9
  - Image page: 10 (EVEN)  
  - Content pages: 11-12 (2 pages)

Chapter 3:
  - Blank page: 13
  - Image page: 14 (EVEN)
  - Content pages: 15-16 (2 pages)

Total pages: 17
```

## Benefits

1. **Accurate Page Estimation**: No more guessing or adding unnecessary blank pages
2. **Consistent Layout**: Chapter images always on even pages
3. **Optimized for Printing**: Proper recto/verso layout for book printing
4. **Target Audience Aware**: Different font sizes properly accounted for
5. **Minimal Blank Pages**: Only adds blank pages when absolutely necessary

## Testing

Run the test script to see how the system works:
```bash
npx tsx scripts/test-page-estimation.ts
```

This will show page calculations for different target audiences and content lengths.

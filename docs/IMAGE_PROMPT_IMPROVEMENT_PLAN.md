# Image Prompt Improvement Plan

## Executive Summary

This document outlines a comprehensive plan to improve image generation prompts based on best practices research and code analysis. The improvements focus on fixing the `{{customInstructions}}` bug, reducing verbosity, enhancing character consistency, and preventing unwanted book cover artifacts.

## Current State Analysis

### 1. Custom Instructions Bug
**Location**: `src/workflows/handlers.ts` line 249  
**Issue**: The code retrieves `storyContext.story.imageGenerationInstructions` which may be `null` or empty in the database.  
**Impact**: Custom instructions are never applied even when users provide them.

### 2. Prompt Verbosity
**Current Structure**:
- Chapter prompts: ~450-500 words with repetitive sections
- Cover prompts: ~350-400 words with repetitive sections
- Each prompt includes full XML-style tags for `<image_purpose>`, `<design_requirements>`, `<technical_specifications>`, `<reference_usage_guidelines>`

**Best Practice**: Research shows optimal prompt length is 200-300 characters (not words), focusing on essential descriptive details.

### 3. Character Description Handling
**Current State**: 
- `text-outline.json` instructs AI to include character descriptions
- Uses physical descriptions instead of names (✓ good practice)
- But could be more explicit about ALWAYS including them

**Issue**: Physical descriptions may not always be consistently included in image prompts.

### 4. Book Cover Physical Book Problem
**Current State**: No explicit instruction to avoid generating images of physical books  
**Impact**: AI may generate an image showing a book with a cover, rather than just the cover image itself.

### 5. Art Style Application
**Current State**: Art style information appears to be applied separately through `imageStyles.json`  
**Potential Issue**: May not be integrated into the main prompt template properly.

---

## Research Findings: AI Image Generation Best Practices (2024-2025)

### Key Principles

1. **Specificity Over Verbosity**
   - Be detailed about what matters (characters, setting, lighting, mood)
   - Remove generic instructions that don't add visual value
   - Keep total prompt concise (200-300 chars optimal)

2. **Character Consistency Techniques**
   - Always include detailed physical descriptions
   - Use same descriptive language across prompts
   - Include character names in descriptions for consistency (e.g., "the boy with brown hair" → "Tom, the boy with brown hair")
   - Reference images are crucial (already implemented ✓)

3. **Negative Prompting**
   - Explicitly state what NOT to include
   - Prevents common AI mistakes
   - Particularly important for avoiding unwanted elements

4. **Technical Photography Terms**
   - For realistic/photorealistic styles: use lighting terms (soft light, golden hour, rim lighting)
   - For illustrations: use art medium terms (watercolor, digital painting, oil painting)
   - Composition terms: rule of thirds, centered, wide shot, close-up

5. **Prompt Structure** (Order matters)
   - Subject (who/what is in the image)
   - Action (what they're doing)
   - Setting (where)
   - Style modifiers (art style, lighting, mood)
   - Technical specs (if needed)
   - Negative prompts (what to avoid)

6. **Avoid Command Language**
   - ❌ "Generate an image of..."
   - ❌ "Create a scene showing..."
   - ✅ "A boy with brown hair playing soccer"
   - ✅ "Sunset over mountains, warm colors, serene atmosphere"

---

## Improvement Plan

### Phase 1: Fix Custom Instructions Bug ⭐ CRITICAL

**Problem**: `{{customInstructions}}` variable is empty because data isn't being saved/loaded properly.

**Investigation Steps**:
1. ✅ Verify database schema has `image_generation_instructions` column (confirmed in `src/db/schema/stories.ts`)
2. Check if the webapp is saving this field when users create/edit stories
3. Verify the workflow properly fetches this field from the database

**Solution**:
```typescript
// In src/workflows/handlers.ts line ~249
const customInstructions = storyContext.story.imageGenerationInstructions;

// Add logging to debug
logger.debug('Custom instructions retrieved', {
  storyId: params.storyId,
  hasCustomInstructions: !!customInstructions,
  customInstructionsLength: customInstructions?.length || 0,
  customInstructionsValue: customInstructions, // Temporary debug log
});
```

**Action Items**:
- [ ] Add debug logging to verify data flow
- [ ] Coordinate with webapp team to ensure field is being saved
- [ ] Test with a story that has custom instructions
- [ ] Document the expected format for custom instructions

---

### Phase 2: Streamline Prompt Templates

#### 2.1 Redesign Chapter Image Prompt

**Current** (`src/prompts/images/chapter.json`):
```json
{
  "systemPrompt": "450+ words with verbose XML tags",
  "userPrompt": "Additional verbose instructions"
}
```

**Proposed New Structure**:
```json
{
  "systemPrompt": "<task>Illustration for chapter in \"{{bookTitle}}\"</task>\n\n<scene>{{promptText}}</scene>\n\n<reference_images>If reference images are provided, maintain consistent character appearances (faces, hair, clothing, proportions) and art style. Create a NEW scene for this chapter - do not copy previous compositions.</reference_images>\n\n{{#customInstructions}}<custom_instructions>{{customInstructions}}</custom_instructions>{{/customInstructions}}\n\n<negative_prompt>Avoid: text, words, speech bubbles, watermarks, signatures, blurry, low quality, distorted anatomy</negative_prompt>",
  "userPrompt": "Generate the illustration now. Focus on character consistency and engaging visual storytelling."
}
```

**Key Changes**:
- ✂️ Removed verbose `<design_requirements>` section
- ✂️ Removed repetitive `<technical_specifications>` 
- ✂️ Simplified `<reference_usage_guidelines>` to essential instruction
- ➕ Added negative prompting
- 📏 Reduced from ~450 words to ~120 words

#### 2.2 Redesign Front Cover Prompt

**Proposed**:
```json
{
  "systemPrompt": "<task>Front cover for book titled \"{{bookTitle}}\" (A5 vertical format)</task>\n\n<description>{{promptText}}</description>\n\n{{#customInstructions}}<custom_instructions>{{customInstructions}}</custom_instructions>{{/customInstructions}}\n\n<composition>Leave space at top for title text overlay. Focus on eye-catching, professional book cover aesthetic that represents the story's essence.</composition>\n\n<negative_prompt>Avoid: showing a physical book, text on the image, words, watermarks, signatures, low quality, 3D book mockup, book spine visible</negative_prompt>",
  "userPrompt": "Generate a professional book cover illustration. Remember: we need the COVER IMAGE ONLY, not an image of a physical book."
}
```

**Key Changes**:
- ✂️ Removed verbose sections
- ➕ **CRITICAL**: Added explicit instruction to avoid physical book images
- ➕ Added negative prompting
- ➕ Specified to leave space for title overlay
- 📏 Reduced from ~350 words to ~100 words

#### 2.3 Redesign Back Cover Prompt

**Proposed**:
```json
{
  "systemPrompt": "<task>Back cover for book titled \"{{bookTitle}}\" (A5 vertical format)</task>\n\n<description>{{promptText}}</description>\n\n<reference_images>If front cover is provided, maintain stylistic continuity (palette, art style) while showing a complementary scene. Do not duplicate the front cover.</reference_images>\n\n{{#customInstructions}}<custom_instructions>{{customInstructions}}</custom_instructions>{{/customInstructions}}\n\n<negative_prompt>Avoid: showing a physical book, text on the image, barcode, ISBN, words, watermarks, signatures, low quality</negative_prompt>",
  "userPrompt": "Generate a professional back cover illustration. Remember: we need the COVER IMAGE ONLY, not an image of a physical book."
}
```

---

### Phase 3: Enhance Character Description Generation

**Goal**: Ensure the AI-generated outline ALWAYS includes detailed character physical descriptions in image prompts.

**File**: `src/prompts/en-US/text-outline.json`

**Current Relevant Section** (lines 56-80):
```json
"<illustration_requirements>
...
<character_naming_rules>
**NEVER use character names in illustration prompts.** Instead, always use:
- Character type (e.g., \"boy\", \"girl\", \"young woman\", \"elderly man\")
- Physical description from the character information
</character_naming_rules>
```

**Proposed Enhancement**:
```json
"<illustration_requirements>
<format_specifications>
- All image prompts must be written in en-US language
- Book cover: A5-vertical format. Include the book title on the cover image but with a big margin from the top of the image.
- Back cover: A5-vertical format (can continue front cover theme)
- Chapter illustrations: Detailed scene descriptions for each chapter
- Style: Use {{graphicalStyle}} aesthetic throughout
</format_specifications>

<character_consistency_rules>
**CRITICAL: Every illustration prompt MUST include full physical descriptions of ALL characters visible in the scene.**

For each character in a scene, ALWAYS include:
- Age/age range (e.g., \"8-year-old boy\", \"young woman in her 20s\")
- Hair (color, length, style)
- Eye color
- Distinctive features (freckles, glasses, clothing style)
- Build/height relative descriptors when relevant

**NEVER use character names alone** - names can be included WITH descriptions:
❌ BAD: \"John playing football\"
✅ GOOD: \"An 8-year-old boy with short brown hair, blue eyes, and a red t-shirt playing football\"
✅ ALSO GOOD: \"Tom, an 8-year-old boy with short brown hair and blue eyes, playing football\"

**Copy physical descriptions consistently** across all chapter prompts for the same character.
</character_consistency_rules>

<safety_guidelines>
ALL illustration prompts MUST be safe & neutral. Keep them simple and compliant:
- No sexual / suggestive content or nudity (especially never sexualize minors)
- No hate, slurs, harassment, bullying
- No graphic violence, gore, self-harm
- No illegal / dangerous activity (weapons, drugs, explosives)
- No deceptive deepfakes or election / political manipulation
- Avoid copyrighted characters & logos; use generic/original concepts
- Focus on setting, mood, actions; keep descriptions wholesome & age-appropriate
</safety_guidelines>

<prompt_structure>
For each illustration prompt, follow this structure:
1. **Setting/Scene**: Where the action takes place (e.g., \"In a sunny park\")
2. **Characters**: Full physical descriptions + what they're doing
3. **Action/Mood**: What's happening, emotional tone
4. **Visual details**: Lighting, composition notes if important

Example: "In a bustling zoo entrance, an 8-year-old girl with curly red hair, green eyes, wearing a yellow sundress stands excitedly pointing at a map. Next to her, a 40-year-old woman with shoulder-length brown hair and glasses smiles warmly. Bright daylight, joyful atmosphere, colorful zoo signs in background."
</prompt_structure>
```

---

### Phase 4: Additional Improvements

#### 4.1 Remove Art Style Duplication

**Investigation needed**: Verify where `imageStyles.json` content is injected and ensure it's not duplicated with template content.

**Files to check**:
- `src/ai/providers/openai/image.ts` (line 124)
- `src/workers/image-edit-worker.ts` (lines 218, 394, 578)

**Proposed**: Art style should be injected ONCE, preferably by the AI provider implementation, NOT in the prompt templates.

#### 4.2 Add Negative Prompts to Image Styles

**File**: `src/prompts/imageStyles.json`

**Proposal**: Add a `negativePrompt` field to each style:

```json
{
  "pixar_style": {
    "systemPrompt": "...",
    "style": "Pixar style, 3D animation...",
    "negativePrompt": "low quality, blurry, distorted, amateur, flat lighting, bad anatomy, text, watermarks"
  }
}
```

#### 4.3 Optimize Story Outline Instructions

**File**: `src/prompts/en-US/text-outline.json`

**Current**: Already has good instructions about character descriptions

**Enhancement**: Add examples of good vs bad image prompts in the template to guide the AI better.

---

## Implementation Priority

### 🔴 CRITICAL (Do First)
1. **Fix custom instructions bug** (Phase 1)
2. **Add negative prompt for book cover physical book issue** (Phase 2.2)
3. **Streamline all three prompt templates** (Phase 2.1, 2.2, 2.3)

### 🟡 HIGH PRIORITY (Do Soon)
4. **Enhance character description instructions** (Phase 3)
5. **Remove art style duplication** (Phase 4.1)

### 🟢 MEDIUM PRIORITY (Nice to Have)
6. **Add negative prompts to image styles** (Phase 4.2)
7. **Add prompt structure examples to outline** (Phase 4.3)

---

## Testing Plan

### Test Cases

1. **Custom Instructions Test**
   - Create a story with custom instructions: "Use warm, golden sunset colors"
   - Verify the instructions appear in generated prompts
   - Verify they affect the final image

2. **Character Consistency Test**
   - Create a multi-chapter story with recurring characters
   - Verify character descriptions are consistent across chapters
   - Verify physical descriptions are always included

3. **Book Cover Test**
   - Generate front and back covers
   - Verify no physical book artifacts appear
   - Verify proper composition with space for title

4. **Prompt Length Test**
   - Measure token count of old vs new prompts
   - Verify new prompts are more concise
   - Ensure quality hasn't degraded

5. **Reference Image Test**
   - Generate multiple chapters
   - Verify reference images are used properly
   - Verify character consistency is maintained

---

## Success Metrics

- ✅ Custom instructions are applied 100% of the time when provided
- ✅ Prompt token count reduced by ~50% (from ~500 to ~250 tokens)
- ✅ Character descriptions present in 100% of prompts with characters
- ✅ Zero instances of physical book showing in cover images
- ✅ User satisfaction with image quality maintained or improved
- ✅ Character consistency improved (subjective measure via user feedback)

---

## Rollout Strategy

### Stage 1: Development & Testing (1 week)
- Implement changes in development environment
- Run automated tests
- Generate test stories manually
- Review image quality

### Stage 2: Staging Validation (3-5 days)
- Deploy to staging
- Generate 10+ test stories with various configurations
- Compare with production results
- Gather feedback from team

### Stage 3: Production Rollout (Gradual)
- Deploy to production
- Monitor error rates and image quality
- Keep old prompts as fallback for 1 week
- Collect user feedback
- Adjust as needed

---

## Dependencies & Risks

### Dependencies
- Webapp team: Ensure `imageGenerationInstructions` field is being saved properly
- Database team: Verify schema is correct and field is populated
- QA team: Extensive testing of various story types and styles

### Risks
1. **Quality Regression**: Shorter prompts might reduce quality
   - **Mitigation**: A/B test old vs new prompts side by side
   
2. **AI Behavior Change**: Different prompt structure might confuse AI
   - **Mitigation**: Test with both OpenAI and Google GenAI providers
   
3. **Breaking Changes**: Template format changes might break existing flows
   - **Mitigation**: Comprehensive testing before deployment

---

## Questions for Stakeholders

1. Are there existing stories with custom instructions we can test with?
2. What is the expected format/content of custom instructions from users?
3. Are there any specific art styles or use cases that need special attention?
4. What is the acceptable trade-off between prompt conciseness and quality?
5. Should we maintain backward compatibility with old prompt format?

---

## Additional Resources

### Research Sources
- [AI Image Generation Best Practices 2024](https://obot.ai/resources/learning-center/ai-image-generation/)
- [Prompt Engineering Guide 2025](https://dev.to/fonyuygita/the-complete-guide-to-prompt-engineering-in-2025)
- [Character Consistency Techniques](https://ai-flow.net/blog/generate-consistent-characters-ai/)
- [Creating Consistent Characters with AI](https://dashtoon.com/blog/consistent-characters-using-ai/)

### Related Documentation
- `docs/ARCHITECTURE.md` - System architecture overview
- `docs/RETRY_IMPLEMENTATION_SUMMARY.md` - Retry and safety block handling
- `src/prompts/README.md` - Prompt system documentation (if exists)

---

## Appendix: Comparison Tables

### Before/After: Chapter Prompt

| Aspect | Before | After | Change |
|--------|--------|-------|--------|
| Word Count | ~450 | ~120 | -73% |
| Token Count | ~600 | ~160 | -73% |
| Sections | 6 | 4 | -33% |
| Negative Prompts | 0 | 1 | ✅ New |
| Custom Instructions | ❌ Broken | ✅ Fixed | ✅ Fixed |

### Before/After: Cover Prompt

| Aspect | Before | After | Change |
|--------|--------|-------|--------|
| Word Count | ~350 | ~100 | -71% |
| Token Count | ~450 | ~130 | -71% |
| Book Artifact Prevention | ❌ No | ✅ Yes | ✅ New |
| Negative Prompts | 0 | 1 | ✅ New |
| Custom Instructions | ❌ Broken | ✅ Fixed | ✅ Fixed |

---

## Document History

- **2025-01-10**: Initial version created based on research and code analysis
- **Status**: Pending review and approval
- **Next Review**: After implementation of Phase 1

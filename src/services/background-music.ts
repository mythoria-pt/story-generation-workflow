/**
 * Background Music Service
 * Selects appropriate background music based on story target audience and novel style
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '@/config/logger.js';

// Background music directory path
// In production (dist), this resolves to dist/backgroundMusics
// In development, we check src/backgroundMusics as fallback
const DIST_MUSIC_DIR = join(process.cwd(), 'dist', 'backgroundMusics');
const SRC_MUSIC_DIR = join(process.cwd(), 'src', 'backgroundMusics');
const BACKGROUND_MUSIC_DIR = existsSync(DIST_MUSIC_DIR) ? DIST_MUSIC_DIR : SRC_MUSIC_DIR;

// -----------------------------------------------------------------------------
// Type Definitions
// -----------------------------------------------------------------------------

export type BackgroundMusicCode =
  | 'bg_soft_bedtime'
  | 'bg_kids_playful_day'
  | 'bg_kids_adventure'
  | 'bg_kids_magic_fantasy'
  | 'bg_tween_reflective'
  | 'bg_teen_adventure'
  | 'bg_dark_tension'
  | 'bg_romantic_warm'
  | 'bg_adult_neutral_focus'
  | 'bg_scifi_space_ambient';

export type TargetAudience =
  | 'children_0-2'
  | 'children_3-6'
  | 'children_7-10'
  | 'children_11-14'
  | 'young_adult_15-17'
  | 'adult_18+'
  | 'all_ages';

export type NovelStyle =
  | 'adventure'
  | 'fantasy'
  | 'mystery'
  | 'romance'
  | 'science_fiction'
  | 'historical'
  | 'contemporary'
  | 'fairy_tale'
  | 'comedy'
  | 'drama'
  | 'horror'
  | 'thriller'
  | 'biography'
  | 'educational'
  | 'poetry'
  | 'sports_adventure';

type StyleGroup =
  | 'adventure'
  | 'speculative'
  | 'mystery'
  | 'dark'
  | 'romance'
  | 'serious'
  | 'light'
  | 'educational';

// -----------------------------------------------------------------------------
// Style Grouping
// -----------------------------------------------------------------------------

/**
 * Collapse novelStyle into a smaller internal category for music selection
 */
function groupStyle(novelStyle: NovelStyle): StyleGroup {
  switch (novelStyle) {
    case 'adventure':
    case 'sports_adventure':
      return 'adventure';

    case 'fantasy':
    case 'fairy_tale':
    case 'science_fiction':
      return 'speculative';

    case 'mystery':
      return 'mystery';

    case 'horror':
    case 'thriller':
      return 'dark';

    case 'romance':
      return 'romance';

    case 'historical':
    case 'drama':
    case 'biography':
    case 'poetry':
      return 'serious';

    case 'educational':
      return 'educational';

    case 'contemporary':
    case 'comedy':
    default:
      return 'light';
  }
}

// -----------------------------------------------------------------------------
// Background Music Selection
// -----------------------------------------------------------------------------

/**
 * Select the appropriate background music code based on target audience and novel style
 */
export function selectBackgroundMusic(
  targetAudience: TargetAudience,
  novelStyle: NovelStyle,
): BackgroundMusicCode {
  const style = groupStyle(novelStyle);

  // 0-2: always ultra-soft
  if (targetAudience === 'children_0-2') {
    return 'bg_soft_bedtime';
  }

  // 3-6
  if (targetAudience === 'children_3-6') {
    if (style === 'speculative') return 'bg_kids_magic_fantasy';
    if (style === 'adventure') return 'bg_kids_adventure';
    if (style === 'mystery' || style === 'dark') return 'bg_kids_adventure'; // soften dark
    if (style === 'light') return 'bg_kids_playful_day';
    if (style === 'educational' || style === 'serious' || style === 'romance') {
      return 'bg_soft_bedtime';
    }
    return 'bg_kids_playful_day';
  }

  // 7-10
  if (targetAudience === 'children_7-10') {
    if (style === 'speculative') return 'bg_kids_magic_fantasy';
    if (style === 'adventure') return 'bg_kids_adventure';
    if (style === 'mystery') return 'bg_kids_adventure';
    if (style === 'dark') return 'bg_kids_adventure'; // still no real horror
    if (style === 'light') return 'bg_kids_playful_day';
    if (style === 'educational') return 'bg_tween_reflective';
    if (style === 'serious' || style === 'romance') return 'bg_tween_reflective';
    return 'bg_kids_playful_day';
  }

  // 11-14 (middle grade)
  if (targetAudience === 'children_11-14') {
    if (style === 'adventure' || style === 'speculative') {
      if (novelStyle === 'science_fiction') return 'bg_scifi_space_ambient';
      return 'bg_teen_adventure';
    }
    if (style === 'mystery') return 'bg_teen_adventure';
    if (style === 'dark') return 'bg_teen_adventure'; // still not full horror
    if (style === 'romance') return 'bg_romantic_warm';
    if (style === 'serious') return 'bg_tween_reflective';
    if (style === 'educational') return 'bg_adult_neutral_focus';
    if (style === 'light') return 'bg_kids_playful_day';
    return 'bg_tween_reflective';
  }

  // 15-17 (young adult)
  if (targetAudience === 'young_adult_15-17') {
    if (style === 'adventure') return 'bg_teen_adventure';
    if (style === 'speculative') {
      return novelStyle === 'science_fiction' ? 'bg_scifi_space_ambient' : 'bg_teen_adventure';
    }
    if (style === 'mystery') return 'bg_teen_adventure';
    if (style === 'dark') return 'bg_dark_tension';
    if (style === 'romance') return 'bg_romantic_warm';
    if (style === 'serious') return 'bg_tween_reflective';
    if (style === 'educational') return 'bg_adult_neutral_focus';
    if (style === 'light') return 'bg_kids_playful_day';
    return 'bg_teen_adventure';
  }

  // Adults
  if (targetAudience === 'adult_18+') {
    if (style === 'adventure') return 'bg_teen_adventure';
    if (style === 'speculative') {
      return novelStyle === 'science_fiction' ? 'bg_scifi_space_ambient' : 'bg_teen_adventure';
    }
    if (style === 'mystery') return 'bg_dark_tension';
    if (style === 'dark') return 'bg_dark_tension';
    if (style === 'romance') return 'bg_romantic_warm';
    if (style === 'serious') return 'bg_adult_neutral_focus';
    if (style === 'educational') return 'bg_adult_neutral_focus';
    if (style === 'light') return 'bg_kids_playful_day';
    return 'bg_adult_neutral_focus';
  }

  // All ages - safe defaults
  if (targetAudience === 'all_ages') {
    if (style === 'speculative') {
      return novelStyle === 'science_fiction' ? 'bg_scifi_space_ambient' : 'bg_kids_magic_fantasy';
    }
    if (style === 'adventure') return 'bg_kids_adventure';
    if (style === 'mystery' || style === 'dark') return 'bg_kids_adventure';
    if (style === 'romance') return 'bg_romantic_warm';
    if (style === 'serious' || style === 'educational') return 'bg_tween_reflective';
    if (style === 'light') return 'bg_kids_playful_day';
  }

  // Fallback - very safe
  return 'bg_adult_neutral_focus';
}

// -----------------------------------------------------------------------------
// File Path Resolution
// -----------------------------------------------------------------------------

/**
 * Get the absolute file path for a background music code
 * Returns null if the file doesn't exist
 */
export function getBackgroundMusicPath(musicCode: BackgroundMusicCode): string | null {
  const filePath = join(BACKGROUND_MUSIC_DIR, `${musicCode}.mp3`);

  if (existsSync(filePath)) {
    logger.debug('Background music file found', { musicCode, filePath });
    return filePath;
  }

  logger.warn('Background music file not found', { musicCode, expectedPath: filePath });
  return null;
}

/**
 * Get background music for a story based on its attributes
 * Returns the file path if available, null otherwise
 */
export function getBackgroundMusicForStory(
  targetAudience: string | null | undefined,
  novelStyle: string | null | undefined,
): { musicCode: BackgroundMusicCode; filePath: string } | null {
  // Default values if not provided
  const audience = (targetAudience as TargetAudience) || 'all_ages';
  const style = (novelStyle as NovelStyle) || 'contemporary';

  // Validate audience is a known value
  const validAudiences: TargetAudience[] = [
    'children_0-2',
    'children_3-6',
    'children_7-10',
    'children_11-14',
    'young_adult_15-17',
    'adult_18+',
    'all_ages',
  ];

  const validStyles: NovelStyle[] = [
    'adventure',
    'fantasy',
    'mystery',
    'romance',
    'science_fiction',
    'historical',
    'contemporary',
    'fairy_tale',
    'comedy',
    'drama',
    'horror',
    'thriller',
    'biography',
    'educational',
    'poetry',
    'sports_adventure',
  ];

  const safeAudience = validAudiences.includes(audience) ? audience : 'all_ages';
  const safeStyle = validStyles.includes(style) ? style : 'contemporary';

  const musicCode = selectBackgroundMusic(safeAudience, safeStyle);
  const filePath = getBackgroundMusicPath(musicCode);

  if (!filePath) {
    logger.info('Background music skipped - file not available', {
      targetAudience: safeAudience,
      novelStyle: safeStyle,
      musicCode,
    });
    return null;
  }

  logger.info('Background music selected', {
    targetAudience: safeAudience,
    novelStyle: safeStyle,
    musicCode,
    filePath,
  });

  return { musicCode, filePath };
}

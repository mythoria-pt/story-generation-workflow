import { spawn } from 'child_process';
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { logger } from '@/config/logger.js';
import { getEnvironment } from '@/config/environment.js';

interface GhostscriptSettings {
  device: string;
  colorConversionStrategy: string;
  processColorModel: string;
  compatibilityLevel: string;
  pdfx: boolean;
  blackPointCompensation: boolean;
  preserveBlacks: boolean;
}

interface ICCProfileConfig {
  profiles: Record<
    string,
    {
      name: string;
      filename: string;
      description: string;
      colorSpace: string;
      outputIntent: string;
      registryName: string;
      info: string;
    }
  >;
  defaultProfile: string;
  grayscaleProfile?: string;
  ghostscriptSettings: GhostscriptSettings;
  grayscaleGhostscriptSettings?: GhostscriptSettings;
}

interface CMYKConversionOptions {
  inputPath: string;
  outputPath: string;
  profileName?: string;
  metadata?: {
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
  };
}

interface ImagePageDetectionOptions {
  imageThreshold?: number;
  dominantAreaRatio?: number;
  minPageCoverageRatio?: number;
  aspectRatioTolerance?: number;
  /**
   * Pages that should ALWAYS be converted to grayscale, even if they contain images.
   * By default, includes page 2 (copyright/technical info page with QR code).
   *
   * Story PDF structure:
   * - Page 1: Title (B&W)
   * - Page 2: Technical/copyright info with QR code (B&W - forced grayscale)
   * - Page 3: Title and subtitle (B&W)
   * - Page 4: Synopsis (B&W)
   * - Page 5: Table of Contents (B&W)
   * - Page 6+: Chapter images (color) followed by chapter text (B&W)
   *
   * The QR code on page 2 triggers image detection but should remain grayscale
   * for proper print output and cost optimization.
   */
  grayscaleOnlyPages?: number[];
}

export class CMYKConversionService {
  private profileConfig: ICCProfileConfig;
  private ghostscriptBinary: string;
  private iccProfilesPath: string;

  constructor() {
    // Load ICC profile configuration
    const configPath =
      process.env.NODE_ENV === 'production'
        ? join(process.cwd(), 'dist', 'config', 'icc-profiles.json')
        : join(process.cwd(), 'src', 'config', 'icc-profiles.json');
    this.profileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));

    // Set Ghostscript binary path based on environment
    const env = getEnvironment();
    if (env.GHOSTSCRIPT_BINARY) {
      // Strip surrounding quotes if provided in env var
      const bin = env.GHOSTSCRIPT_BINARY.trim();
      this.ghostscriptBinary = bin.startsWith('"') && bin.endsWith('"') ? bin.slice(1, -1) : bin;
    } else {
      // Default binary name, with Windows auto-discovery fallback
      if (process.platform === 'win32') {
        this.ghostscriptBinary = this.findGhostscriptOnWindows() || 'gswin64c.exe';
      } else {
        this.ghostscriptBinary = 'gs';
      }
    }

    // Set ICC profiles path - in production this will be in the container
    this.iccProfilesPath =
      process.env.NODE_ENV === 'production'
        ? '/app/icc-profiles'
        : join(process.cwd(), 'icc-profiles');

    logger.info('CMYK Conversion Service initialized', {
      ghostscriptBinary: this.ghostscriptBinary,
      iccProfilesPath: this.iccProfilesPath,
      defaultProfile: this.profileConfig.defaultProfile,
      grayscaleProfile: this.profileConfig.grayscaleProfile,
    });
  }

  /**
   * Attempt to discover Ghostscript installation on Windows
   */
  private findGhostscriptOnWindows(): string | null {
    try {
      const programFiles = process.env['ProgramFiles'] || 'C:\\\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\\\Program Files (x86)';
      const candidates: string[] = [];
      const versionsToCheck = [
        // Common recent versions first; we also do a directory scan below
        'gs10.04.0',
        'gs10.03.1',
        'gs10.02.1',
        'gs10.01.2',
        'gs10.00.0',
      ];

      for (const base of [programFiles, programFilesX86]) {
        for (const ver of versionsToCheck) {
          candidates.push(join(base, 'gs', ver, 'bin', 'gswin64c.exe'));
          candidates.push(join(base, 'gs', ver, 'bin', 'gswin32c.exe'));
        }
        // Also check generic wildcard-like locations for the latest installed version
        try {
          const gsRoot = join(base, 'gs');
          if (existsSync(gsRoot)) {
            const dirs = readdirSync(gsRoot)
              .filter((d: string) => d.startsWith('gs'))
              .sort() // lexicographic; good enough to pick last as newest
              .reverse();
            for (const d of dirs) {
              candidates.push(join(gsRoot, d, 'bin', 'gswin64c.exe'));
              candidates.push(join(gsRoot, d, 'bin', 'gswin32c.exe'));
            }
          }
        } catch {
          // ignore
        }
      }

      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Validate Ghostscript installation
   */
  async validateGhostscript(): Promise<boolean> {
    try {
      const version = await new Promise<string>((resolve, reject) => {
        const child = spawn(this.ghostscriptBinary, ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => {
          out += d.toString();
        });
        child.stderr?.on('data', (d) => {
          err += d.toString();
        });
        child.on('error', (e) => reject(e));
        child.on('close', (code) => {
          if (code === 0) resolve(out.trim());
          else reject(new Error(err || `exit ${code}`));
        });
      });
      logger.info('Ghostscript validation successful', { version });
      return true;
    } catch (error) {
      logger.error('Ghostscript validation failed', {
        error: error instanceof Error ? error.message : String(error),
        binary: this.ghostscriptBinary,
      });
      return false;
    }
  }

  /**
   * Get ICC profile path
   */
  private getICCProfilePath(profileName?: string): string {
    const profile = profileName || this.profileConfig.defaultProfile;
    const profileInfo = this.profileConfig.profiles[profile];

    if (!profileInfo) {
      throw new Error(`ICC profile not found: ${profile}`);
    }

    const profilePath = join(this.iccProfilesPath, profileInfo.filename);

    if (!existsSync(profilePath)) {
      logger.warn(`ICC profile file not found: ${profilePath}, using built-in CMYK conversion`);
      return '';
    }

    // Check if it's a real ICC profile (binary file, should be > 1KB)
    const stats = statSync(profilePath);
    if (stats.size < 1 * 1024) {
      logger.warn(
        `ICC profile file too small (${stats.size} bytes), likely a placeholder. Using built-in CMYK conversion`,
      );
      return '';
    }

    // Check if it's a text file (placeholder)
    const firstBytes = readFileSync(profilePath, { encoding: 'utf8', flag: 'r' }).substring(0, 100);
    if (firstBytes.includes('ICC Profile Placeholder') || firstBytes.includes('#')) {
      logger.warn(`ICC profile is a placeholder file. Using built-in CMYK conversion`);
      return '';
    }

    return profilePath;
  }

  private buildGhostscriptArgs(
    settings: GhostscriptSettings,
    iccProfilePath: string,
    inputPath: string,
    outputPath: string,
  ): string[] {
    const gsArgs = [
      '-dSAFER',
      '-dBATCH',
      '-dNOPAUSE',
      `-sDEVICE=${settings.device}`,
      `-dCompatibilityLevel=${settings.compatibilityLevel}`,
      `-dColorConversionStrategy=/${settings.colorConversionStrategy}`,
      `-dProcessColorModel=/${settings.processColorModel}`,
      '-dOverrideICC',
      '-dDeviceGrayToK',
      '-dAutoRotatePages=/None',
      '-dEmbedAllFonts',
      '-dSubsetFonts',
    ];

    if (settings.pdfx) {
      gsArgs.push('-dPDFX=true');
    }
    if (settings.blackPointCompensation) {
      gsArgs.push('-dBlackPointCompensation=true');
    }

    if (iccProfilePath) {
      const isGray = settings.processColorModel.toLowerCase() === 'devicegray';
      const defaultProfileFlag = isGray ? '-sDefaultGrayProfile' : '-sDefaultCMYKProfile';
      gsArgs.push(`${defaultProfileFlag}=${iccProfilePath}`);
      // Note: -sOutputICCProfile is intentionally NOT used here as it causes
      // "Unrecoverable error, exit code 1" with Ghostscript 10.x on Windows.
      // The Default*Profile flag is sufficient for color conversion.
    } else {
      logger.info('Proceeding without ICC profile for Ghostscript conversion');
    }

    gsArgs.push('-o');
    gsArgs.push(outputPath);
    gsArgs.push(inputPath);

    return gsArgs;
  }

  private async runGhostscript(args: string[]): Promise<{ stdout: string; stderr: string }> {
    // Log the full command for debugging (useful when troubleshooting GS issues)
    logger.debug('Executing Ghostscript command', {
      binary: this.ghostscriptBinary,
      argCount: args.length,
      fullCommand: `"${this.ghostscriptBinary}" ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
    });

    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(this.ghostscriptBinary, args, {
        timeout: 300000, // 5 minutes timeout
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to execute Ghostscript: ${error.message}`));
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Ghostscript exited with code ${code}. Stderr: ${stderr}`));
        }
      });
    });
  }

  private detectImagePagesWithPdfLib(pdfDoc: PDFDocument, grayscaleOnlyPages: Set<number> = new Set()): Set<number> {
    const imagePages = new Set<number>();
    const pages = pdfDoc.getPages();

    for (let i = 0; i < pages.length; i++) {
      const pageNumber = i + 1;
      // Skip pages that are forced to grayscale
      if (grayscaleOnlyPages.has(pageNumber)) continue;

      const page = pages[i];
      const node = (page as any).node;
      if (!node || typeof node.Resources !== 'function') continue;

      const resources = node.Resources();
      const xObject = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xObject) continue;

      for (const key of xObject.keys()) {
        const xObj = xObject.lookupMaybe(key, PDFStream);
        const subtype = xObj?.dict?.lookupMaybe(PDFName.of('Subtype'), PDFName);
        const subtypeName = subtype?.asString();
        if (subtypeName === '/Image' || subtypeName === 'Image') {
          imagePages.add(pageNumber);
          break;
        }
      }
    }

    return imagePages;
  }

  async detectLargeImagePages(
    pdfPath: string,
    options: ImagePageDetectionOptions = {},
  ): Promise<Set<number>> {
    const imageThreshold = options.imageThreshold ?? 300;
    const dominantAreaRatio = options.dominantAreaRatio ?? 0.4;
    const minPageCoverageRatio = options.minPageCoverageRatio ?? 0.18;
    const aspectRatioTolerance = options.aspectRatioTolerance ?? 0.25;

    // Pages that should always be grayscale regardless of image detection.
    // Default: page 2 contains a QR code which triggers image detection but
    // should remain grayscale (it's the copyright/technical info page).
    const grayscaleOnlyPages = new Set(options.grayscaleOnlyPages ?? [2]);

    if (!existsSync(pdfPath)) {
      throw new Error(`Input PDF file not found for image detection: ${pdfPath}`);
    }

    const pdfBytes = readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const parser = new PDFParse({
      data: pdfBytes,
      useWasm: false, // avoid dynamic import restrictions in Node test/runtime without vm module flags
    });

    try {
      const images = await parser.getImage({
        imageThreshold,
        imageBuffer: false,
        imageDataUrl: false,
      });

      let maxImageArea = 0;
      images.pages.forEach((page) => {
        page.images.forEach((img) => {
          const area = img.width * img.height;
          if (area > maxImageArea) {
            maxImageArea = area;
          }
        });
      });

      const imagePages = new Set<number>();
      images.pages.forEach((page) => {
        if (page.images.length === 0) return;

        const largestImage = page.images.reduce((prev, current) => {
          const prevArea = prev.width * prev.height;
          const currentArea = current.width * current.height;
          return currentArea > prevArea ? current : prev;
        });

        const largestArea = largestImage.width * largestImage.height;
        const normalizedArea = maxImageArea > 0 ? largestArea / maxImageArea : 0;
        const pageRef = pdfDoc.getPage(page.pageNumber - 1);
        const pageArea = pageRef.getWidth() * pageRef.getHeight();
        const pageCoverage = pageArea > 0 ? largestArea / pageArea : 0;
        const pageAspect = pageRef.getWidth() / pageRef.getHeight();
        const imageAspect = largestImage.width / largestImage.height;
        const aspectDelta = Math.abs(pageAspect - imageAspect) / pageAspect;

        const dominantImage = normalizedArea >= dominantAreaRatio;
        const coversPage = pageCoverage >= minPageCoverageRatio;
        const aspectAligned = aspectDelta <= aspectRatioTolerance;

        if (dominantImage || (coversPage && aspectAligned)) {
          // Skip pages that are forced to grayscale (e.g., page 2 with QR code)
          if (!grayscaleOnlyPages.has(page.pageNumber)) {
            imagePages.add(page.pageNumber);
          }
        }
      });

      // Log which pages were excluded due to grayscaleOnlyPages setting
      if (grayscaleOnlyPages.size > 0) {
        logger.debug('Pages forced to grayscale (excluded from color detection)', {
          grayscaleOnlyPages: [...grayscaleOnlyPages],
        });
      }

      if (imagePages.size > 0) {
        logger.info('Detected image-heavy pages via pdf-parse', { pages: [...imagePages] });
        return imagePages;
      }

      const fallback = this.detectImagePagesWithPdfLib(pdfDoc, grayscaleOnlyPages);
      if (fallback.size > 0) {
        logger.info('Detected image-heavy pages via pdf-lib fallback', { pages: [...fallback] });
      }
      return fallback;
    } catch (error) {
      logger.warn('Failed to detect image pages; falling back to pdf-lib detection', {
        error: error instanceof Error ? error.message : String(error),
      });
      const fallback = this.detectImagePagesWithPdfLib(pdfDoc, grayscaleOnlyPages);
      return fallback;
    } finally {
      if (typeof parser.destroy === 'function') {
        await parser.destroy();
      }
    }
  }

  async applyGrayProfileToTextPages(options: {
    inputPath: string;
    outputPath: string;
    colorPageNumbers?: number[];
    detectionOptions?: ImagePageDetectionOptions;
  }): Promise<string> {
    logger.info('Starting grayscale conversion for text pages', {
      input: options.inputPath,
      output: options.outputPath,
      providedColorPages: options.colorPageNumbers?.length ?? 0,
    });

    if (!existsSync(options.inputPath)) {
      throw new Error(`Input PDF file not found: ${options.inputPath}`);
    }

    const isGhostscriptValid = await this.validateGhostscript();
    if (!isGhostscriptValid) {
      throw new Error('Ghostscript validation failed');
    }

    const grayProfileName = this.profileConfig.grayscaleProfile || this.profileConfig.defaultProfile;
    const grayProfilePath = this.getICCProfilePath(grayProfileName);

    const grayscaleSettings: GhostscriptSettings = this.profileConfig.grayscaleGhostscriptSettings ?? {
      ...this.profileConfig.ghostscriptSettings,
      colorConversionStrategy: 'Gray',
      processColorModel: 'DeviceGray',
    };

    const colorPages =
      options.colorPageNumbers && options.colorPageNumbers.length > 0
        ? new Set(options.colorPageNumbers)
        : await this.detectLargeImagePages(options.inputPath, options.detectionOptions);

    const extension = extname(options.outputPath);
    const grayTempPath = join(
      dirname(options.outputPath),
      `${basename(options.outputPath, extension)}-gray-temp${extension}`,
    );

    try {
      const gsArgs = this.buildGhostscriptArgs(
        grayscaleSettings,
        grayProfilePath,
        options.inputPath,
        grayTempPath,
      );
      const result = await this.runGhostscript(gsArgs);
      if (result.stderr && !result.stderr.includes('Warning')) {
        logger.warn('Ghostscript stderr output during grayscale conversion', { stderr: result.stderr });
      }

      const originalBytes = readFileSync(options.inputPath);
      const grayBytes = readFileSync(grayTempPath);

      const originalDoc = await PDFDocument.load(originalBytes);
      const grayDoc = await PDFDocument.load(grayBytes);

      if (originalDoc.getPageCount() !== grayDoc.getPageCount()) {
        throw new Error('Page count mismatch after grayscale conversion');
      }

      for (let pageIndex = 0; pageIndex < originalDoc.getPageCount(); pageIndex++) {
        const pageNumber = pageIndex + 1;
        if (colorPages.has(pageNumber)) continue;

        const [grayPage] = await originalDoc.copyPages(grayDoc, [pageIndex]);
        originalDoc.removePage(pageIndex);
        originalDoc.insertPage(pageIndex, grayPage);
      }

      const mergedBytes = await originalDoc.save();
      writeFileSync(options.outputPath, mergedBytes);

      logger.info('Grayscale conversion applied to text pages', {
        output: options.outputPath,
        colorPages: [...colorPages].sort((a, b) => a - b),
      });

      return options.outputPath;
    } catch (error) {
      logger.error('Failed to apply grayscale conversion to text pages', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (existsSync(grayTempPath)) {
        try {
          unlinkSync(grayTempPath);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  /**
   * Convert RGB PDF to CMYK PDF/X-1a
   */
  async convertToCMYK(options: CMYKConversionOptions): Promise<string> {
    logger.info('Starting CMYK conversion', {
      input: options.inputPath,
      output: options.outputPath,
      profile: options.profileName || this.profileConfig.defaultProfile,
    });

    // Validate input file exists
    if (!existsSync(options.inputPath)) {
      throw new Error(`Input PDF file not found: ${options.inputPath}`);
    }

    // Validate Ghostscript
    const isGhostscriptValid = await this.validateGhostscript();
    if (!isGhostscriptValid) {
      throw new Error('Ghostscript validation failed');
    }

    // Get ICC profile path
    const iccProfilePath = this.getICCProfilePath(options.profileName);

    try {
      // Build Ghostscript command for CMYK conversion
      if (iccProfilePath) {
        logger.info('Using ICC profile for CMYK conversion', { profilePath: iccProfilePath });
      } else {
        logger.info('Using built-in CMYK conversion (no ICC profile)');
      }
      const gsArgs = this.buildGhostscriptArgs(
        this.profileConfig.ghostscriptSettings,
        iccProfilePath,
        options.inputPath,
        options.outputPath,
      );
      const result = await this.runGhostscript(gsArgs);

      if (result.stderr && !result.stderr.includes('Warning')) {
        logger.warn('Ghostscript stderr output', { stderr: result.stderr });
      }

      // Verify output file was created
      if (!existsSync(options.outputPath)) {
        throw new Error('CMYK PDF was not generated');
      }

      logger.info('CMYK conversion completed successfully', {
        input: options.inputPath,
        output: options.outputPath,
        outputSize: statSync(options.outputPath).size,
      });

      return options.outputPath;
    } catch (error) {
      logger.error('CMYK conversion failed', {
        error: error instanceof Error ? error.message : String(error),
        input: options.inputPath,
        output: options.outputPath,
      });
      throw error;
    }
  }

  /**
   * Generate CMYK filename from RGB filename
   */
  generateCMYKFilename(rgbPath: string): string {
    const dir = dirname(rgbPath);
    const ext = extname(rgbPath);
    const name = basename(rgbPath, ext);
    return join(dir, `${name}-cmyk${ext}`);
  }

  /**
   * Convert both interior and cover PDFs to CMYK
   */
  async convertPrintSetToCMYK(
    interiorPath: string,
    coverPath: string,
    metadata?: CMYKConversionOptions['metadata'],
  ): Promise<{ interiorCMYK: string; coverCMYK: string }> {
    const interiorCMYKPath = this.generateCMYKFilename(interiorPath);
    const coverCMYKPath = this.generateCMYKFilename(coverPath);

    logger.info('Converting print set to CMYK', {
      interior: { rgb: interiorPath, cmyk: interiorCMYKPath },
      cover: { rgb: coverPath, cmyk: coverCMYKPath },
    });

    // Convert both PDFs in parallel for efficiency
    const [interiorResult, coverResult] = await Promise.all([
      this.convertToCMYK({
        inputPath: interiorPath,
        outputPath: interiorCMYKPath,
        metadata: { ...metadata, subject: `${metadata?.subject || 'Story'} - Interior` },
      }),
      this.convertToCMYK({
        inputPath: coverPath,
        outputPath: coverCMYKPath,
        metadata: { ...metadata, subject: `${metadata?.subject || 'Story'} - Cover` },
      }),
    ]);

    return {
      interiorCMYK: interiorResult,
      coverCMYK: coverResult,
    };
  }
}

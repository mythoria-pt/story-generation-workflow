import { spawn } from 'child_process';
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { PDFDocument } from 'pdf-lib';
import { logger } from '@/config/logger.js';
import { getEnvironment } from '@/config/environment.js';

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
  ghostscriptSettings: {
    device: string;
    colorConversionStrategy: string;
    processColorModel: string;
    compatibilityLevel: string;
    pdfx: boolean;
    blackPointCompensation: boolean;
    preserveBlacks: boolean;
  };
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

    // Check if it's a real ICC profile (binary file, should be > 100KB)
    const stats = statSync(profilePath);
    if (stats.size < 100 * 1024) {
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

  /**
   * Execute Ghostscript with the provided arguments and verify output creation.
   */
  private async runGhostscript(args: string[], outputPath: string): Promise<void> {
    logger.debug('Executing Ghostscript command', {
      binary: this.ghostscriptBinary,
      argCount: args.length,
    });

    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
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

    if (result.stderr && !result.stderr.includes('Warning')) {
      logger.warn('Ghostscript stderr output', { stderr: result.stderr });
    }

    if (!existsSync(outputPath)) {
      throw new Error('Expected output PDF was not generated');
    }
  }

  /**
   * Build a variant filename using a suffix.
   */
  private buildVariantPath(basePath: string, suffix: string): string {
    const dir = dirname(basePath);
    const ext = extname(basePath);
    const name = basename(basePath, ext);
    return join(dir, `${name}${suffix}${ext}`);
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
      const { ghostscriptSettings } = this.profileConfig;
      const gsArgs = [
        '-dSAFER',
        '-dBATCH',
        '-dNOPAUSE',
        `-sDEVICE=${ghostscriptSettings.device}`,
        `-dCompatibilityLevel=${ghostscriptSettings.compatibilityLevel}`,
        '-dColorConversionStrategy=/CMYK',
        '-dProcessColorModel=/DeviceCMYK',
        '-dOverrideICC',
        '-dDeviceGrayToK',
        '-dAutoRotatePages=/None',
        '-dEmbedAllFonts',
        '-dSubsetFonts',
      ];

      // Add ICC profile if available
      if (iccProfilePath) {
        gsArgs.push(`-sDefaultCMYKProfile=${iccProfilePath}`);
        logger.info('Using ICC profile for CMYK conversion', { profilePath: iccProfilePath });
      } else {
        logger.info('Using built-in CMYK conversion (no ICC profile)');
      }

      // Use -o shorthand for output file
      gsArgs.push('-o');
      gsArgs.push(options.outputPath);
      gsArgs.push(options.inputPath);

      await this.runGhostscript(gsArgs, options.outputPath);

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
   * Convert an RGB PDF to grayscale while preserving embedded black text.
   */
  private async convertToGrayscale(options: CMYKConversionOptions): Promise<string> {
    logger.info('Starting grayscale conversion', {
      input: options.inputPath,
      output: options.outputPath,
    });

    if (!existsSync(options.inputPath)) {
      throw new Error(`Input PDF file not found: ${options.inputPath}`);
    }

    const isGhostscriptValid = await this.validateGhostscript();
    if (!isGhostscriptValid) {
      throw new Error('Ghostscript validation failed');
    }

    const gsArgs = [
      '-dSAFER',
      '-dBATCH',
      '-dNOPAUSE',
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      '-dColorConversionStrategy=/Gray',
      '-dProcessColorModel=/DeviceGray',
      '-dOverrideICC',
      '-dDeviceGrayToK',
      '-dAutoRotatePages=/None',
      '-dEmbedAllFonts',
      '-dSubsetFonts',
      '-o',
      options.outputPath,
      options.inputPath,
    ];

    await this.runGhostscript(gsArgs, options.outputPath);

    logger.info('Grayscale conversion completed successfully', {
      input: options.inputPath,
      output: options.outputPath,
      outputSize: statSync(options.outputPath).size,
    });

    return options.outputPath;
  }

  /**
   * Merge grayscale text pages with color CMYK image pages.
   */
  private async mergeSelectivePages(
    colorPath: string,
    grayscalePath: string,
    colorPageNumbers: number[],
    outputPath: string,
  ): Promise<void> {
    logger.info('Starting selective page merge', {
      colorPath,
      grayscalePath,
      colorPageNumbers: colorPageNumbers.sort((a, b) => a - b),
      colorPageCount: colorPageNumbers.length,
    });

    const colorDoc = await PDFDocument.load(readFileSync(colorPath));
    const grayscaleDoc = await PDFDocument.load(readFileSync(grayscalePath));

    const totalPages = colorDoc.getPageCount();
    logger.info('Loaded PDFs for merging', {
      totalPagesInColorPDF: totalPages,
      totalPagesInGrayscalePDF: grayscaleDoc.getPageCount(),
      colorPageNumbers: colorPageNumbers.sort((a, b) => a - b),
    });

    if (grayscaleDoc.getPageCount() !== totalPages) {
      throw new Error('Mismatched page counts between color and grayscale PDFs');
    }

    const finalDoc = await PDFDocument.create();
    const colorPagesSet = new Set(colorPageNumbers);

    const colorPagesList: number[] = [];
    const grayscalePagesList: number[] = [];

    for (let i = 0; i < totalPages; i++) {
      const pageNumber = i + 1; // 1-based page number
      const useColorForThisPage = colorPagesSet.has(pageNumber);
      const sourceDoc = useColorForThisPage ? colorDoc : grayscaleDoc;
      const [page] = await finalDoc.copyPages(sourceDoc, [i]);
      finalDoc.addPage(page);

      if (useColorForThisPage) {
        colorPagesList.push(pageNumber);
      } else {
        grayscalePagesList.push(pageNumber);
      }
    }

    logger.info('Page merge completed', {
      totalPages,
      colorPages: colorPagesList,
      grayscalePages: grayscalePagesList,
      colorPageCount: colorPagesList.length,
      grayscalePageCount: grayscalePagesList.length,
    });

    const bytes = await finalDoc.save();
    writeFileSync(outputPath, bytes);

    logger.info('Selective page merge saved', {
      outputPath,
      outputSize: bytes.length,
    });
  }

  /**
   * Convert both interior and cover PDFs to CMYK
   */
  async convertPrintSetToCMYK(
    interiorPath: string,
    coverPath: string,
    metadata?: CMYKConversionOptions['metadata'],
    imagePageNumbers: number[] = [],
  ): Promise<{ interiorCMYK: string; coverCMYK: string }> {
    const interiorCMYKPath = this.generateCMYKFilename(interiorPath);
    const coverCMYKPath = this.generateCMYKFilename(coverPath);
    const normalizedMetadata: NonNullable<CMYKConversionOptions['metadata']> = metadata ?? {};

    logger.info('Converting print set to CMYK', {
      interior: { rgb: interiorPath, cmyk: interiorCMYKPath },
      cover: { rgb: coverPath, cmyk: coverCMYKPath },
      imagePageNumbers: imagePageNumbers.sort((a, b) => a - b),
      imagePageCount: imagePageNumbers.length,
      selectiveConversionEnabled: imagePageNumbers.length > 0,
    });

    const convertInterior = imagePageNumbers.length
      ? async () => {
          const colorPath = this.buildVariantPath(interiorCMYKPath, '-color');
          const grayPath = this.buildVariantPath(interiorCMYKPath, '-gray');

          const interiorMetadata = {
            ...normalizedMetadata,
            subject: `${normalizedMetadata.subject || 'Story'} - Interior`,
          };

          await Promise.all([
            this.convertToCMYK({
              inputPath: interiorPath,
              outputPath: colorPath,
              metadata: interiorMetadata,
            }),
            this.convertToGrayscale({
              inputPath: interiorPath,
              outputPath: grayPath,
              metadata: normalizedMetadata,
            }),
          ]);

          await this.mergeSelectivePages(colorPath, grayPath, imagePageNumbers, interiorCMYKPath);
          return interiorCMYKPath;
        }
      : async () =>
          this.convertToCMYK({
            inputPath: interiorPath,
            outputPath: interiorCMYKPath,
            metadata: {
              ...normalizedMetadata,
              subject: `${normalizedMetadata.subject || 'Story'} - Interior`,
            },
          });

    // Convert both PDFs in parallel for efficiency
    const [interiorResult, coverResult] = await Promise.all([
      convertInterior(),
      this.convertToCMYK({
        inputPath: coverPath,
        outputPath: coverCMYKPath,
        metadata: {
          ...normalizedMetadata,
          subject: `${normalizedMetadata.subject || 'Story'} - Cover`,
        },
      }),
    ]);

    return {
      interiorCMYK: interiorResult as string,
      coverCMYK: coverResult as string,
    };
  }
}

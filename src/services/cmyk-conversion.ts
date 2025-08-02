import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { logger } from '@/config/logger.js';
import { getEnvironment } from '@/config/environment.js';

const execAsync = promisify(exec);

interface ICCProfileConfig {
  profiles: Record<string, {
    name: string;
    filename: string;
    description: string;
    colorSpace: string;
    outputIntent: string;
    registryName: string;
    info: string;
  }>;
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
    const configPath = process.env.NODE_ENV === 'production' 
      ? join(process.cwd(), 'dist', 'config', 'icc-profiles.json')
      : join(process.cwd(), 'src', 'config', 'icc-profiles.json');
    this.profileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));

    // Set Ghostscript binary path based on environment
    const env = getEnvironment();
    if (env.GHOSTSCRIPT_BINARY) {
      this.ghostscriptBinary = env.GHOSTSCRIPT_BINARY;
    } else {
      // Default paths for different environments
      this.ghostscriptBinary = process.platform === 'win32' ? 'gswin64c.exe' : 'gs';
    }

    // Set ICC profiles path - in production this will be in the container
    this.iccProfilesPath = process.env.NODE_ENV === 'production' 
      ? '/app/icc-profiles' 
      : join(process.cwd(), 'icc-profiles');

    logger.info('CMYK Conversion Service initialized', {
      ghostscriptBinary: this.ghostscriptBinary,
      iccProfilesPath: this.iccProfilesPath,
      defaultProfile: this.profileConfig.defaultProfile
    });
  }

  /**
   * Validate Ghostscript installation
   */
  async validateGhostscript(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`${this.ghostscriptBinary} --version`);
      logger.info('Ghostscript validation successful', { version: stdout.trim() });
      return true;
    } catch (error) {
      logger.error('Ghostscript validation failed', { 
        error: error instanceof Error ? error.message : String(error),
        binary: this.ghostscriptBinary 
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
      logger.warn(`ICC profile file too small (${stats.size} bytes), likely a placeholder. Using built-in CMYK conversion`);
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
   * Convert RGB PDF to CMYK PDF/X-1a
   */
  async convertToCMYK(options: CMYKConversionOptions): Promise<string> {
    logger.info('Starting CMYK conversion', {
      input: options.inputPath,
      output: options.outputPath,
      profile: options.profileName || this.profileConfig.defaultProfile
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
        '-dSubsetFonts'
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

      // Execute Ghostscript command
      const commandArgs = gsArgs.slice();
      
      logger.debug('Executing Ghostscript command', { 
        binary: this.ghostscriptBinary,
        argCount: commandArgs.length
      });

      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(this.ghostscriptBinary, commandArgs, {
          timeout: 300000, // 5 minutes timeout
          stdio: ['ignore', 'pipe', 'pipe']
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

      // Verify output file was created
      if (!existsSync(options.outputPath)) {
        throw new Error('CMYK PDF was not generated');
      }

      logger.info('CMYK conversion completed successfully', {
        input: options.inputPath,
        output: options.outputPath,
        outputSize: statSync(options.outputPath).size
      });

      return options.outputPath;

    } catch (error) {
      logger.error('CMYK conversion failed', {
        error: error instanceof Error ? error.message : String(error),
        input: options.inputPath,
        output: options.outputPath
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
    metadata?: CMYKConversionOptions['metadata']
  ): Promise<{ interiorCMYK: string; coverCMYK: string }> {
    
    const interiorCMYKPath = this.generateCMYKFilename(interiorPath);
    const coverCMYKPath = this.generateCMYKFilename(coverPath);

    logger.info('Converting print set to CMYK', {
      interior: { rgb: interiorPath, cmyk: interiorCMYKPath },
      cover: { rgb: coverPath, cmyk: coverCMYKPath }
    });

    // Convert both PDFs in parallel for efficiency
    const [interiorResult, coverResult] = await Promise.all([
      this.convertToCMYK({
        inputPath: interiorPath,
        outputPath: interiorCMYKPath,
        metadata: { ...metadata, subject: `${metadata?.subject || 'Story'} - Interior` }
      }),
      this.convertToCMYK({
        inputPath: coverPath,
        outputPath: coverCMYKPath,
        metadata: { ...metadata, subject: `${metadata?.subject || 'Story'} - Cover` }
      })
    ]);

    return {
      interiorCMYK: interiorResult,
      coverCMYK: coverResult
    };
  }
}

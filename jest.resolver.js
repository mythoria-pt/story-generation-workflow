import { resolve } from 'path';
import { existsSync } from 'fs';

export default (path, options) => {
  // Handle .js imports that should resolve to .ts files
  if (path.endsWith('.js')) {
    const tsPath = path.replace(/\.js$/, '.ts');
    const fullTsPath = resolve(options.basedir, tsPath);
    if (existsSync(fullTsPath)) {
      return fullTsPath;
    }
  }

  // Default resolver behavior
  return options.defaultResolver(path, options);
};

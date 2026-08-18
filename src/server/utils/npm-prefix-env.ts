import { normalize, resolve } from 'path';

import { getZhiShiDataDir } from './app-dirs';



const NPM_PREFIX_ENV_KEYS = [

  'npm_config_prefix',

  'NPM_CONFIG_PREFIX',

  'PREFIX',

] as const;



function isWindowsPlatform(platform = process.platform): boolean {

  return platform === 'win32';

}



export function getZhiShiNpmGlobalPrefix(

  platform = process.platform,

): string {

  const dataDir = getZhiShiDataDir();

  return isWindowsPlatform(platform)

    ? resolve(dataDir, 'npm-global')

    : `${dataDir}/npm-global`;

}



export function getZhiShiNpmGlobalBinDir(

  platform = process.platform,

): string {

  const prefix = getZhiShiNpmGlobalPrefix(platform);

  // npm on Windows puts command shims under prefix root, not prefix/bin.

  return isWindowsPlatform(platform) ? prefix : `${prefix}/bin`;

}



function normalizeForCompare(pathValue: string, platform = process.platform): string {

  let normalized = normalize(pathValue);

  while (normalized.length > 1 && /[/\\]$/.test(normalized)) {

    normalized = normalized.slice(0, -1);

  }

  return isWindowsPlatform(platform) ? normalized.toLowerCase() : normalized;

}



function samePath(a: string, b: string, platform = process.platform): boolean {

  return normalizeForCompare(a, platform) === normalizeForCompare(b, platform);

}



export function scrubZhiShiNpmPrefixEnv(

  env: NodeJS.ProcessEnv,

  zhishiPrefix: string | null,

  platform = process.platform,

): void {

  if (!zhishiPrefix) return;



  for (const key of NPM_PREFIX_ENV_KEYS) {

    const value = env[key];

    if (value && samePath(value, zhishiPrefix, platform)) {

      delete env[key];

    }

  }

}


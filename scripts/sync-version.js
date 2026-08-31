/**
 * 同步版本号到 Tauri 配置文件
 * 由 npm version 钩子自动调用
 *
 * 数据源: package.json (单一数据源)
 * 同步目标: src-tauri/tauri.conf.json, src-tauri/Cargo.toml,
 *           src/shared/constants.ts（GUI_VERSION——1.4.8/1.4.9 两次发版漏同步
 *           的教训：GUI 关于页版本号必须进同一同步链）
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// 读取 package.json 的版本号
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
const version = packageJson.version;

// 校验版本号格式 (semver: x.y.z)
if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`错误: 版本号格式无效 "${version}"，应为 x.y.z`);
    process.exit(1);
}

console.log(`同步版本号: ${version}`);

// 更新 tauri.conf.json
const tauriConfPath = join(rootDir, 'src-tauri/tauri.conf.json');
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'));
tauriConf.version = version;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf-8');
console.log('  ✓ src-tauri/tauri.conf.json');

// 更新 Cargo.toml（正则失配必须报错退出——静默 ✓ 会让发版版本号漂移，1.4.8/1.4.9 教训）
const cargoPath = join(rootDir, 'src-tauri/Cargo.toml');
let cargoContent = readFileSync(cargoPath, 'utf-8');
const cargoVersionRe = /^version = "[0-9]+\.[0-9]+\.[0-9]+"/m;
if (!cargoVersionRe.test(cargoContent)) {
    console.error('错误: src-tauri/Cargo.toml 中未匹配到 version = "x.y.z"，未做替换');
    process.exit(1);
}
cargoContent = cargoContent.replace(cargoVersionRe, `version = "${version}"`);
writeFileSync(cargoPath, cargoContent, 'utf-8');
console.log('  ✓ src-tauri/Cargo.toml');

// 更新 GUI_VERSION（src/shared/constants.ts——GUI 关于页版本号）
const constantsPath = join(rootDir, 'src/shared/constants.ts');
let constantsContent = readFileSync(constantsPath, 'utf-8');
const guiVersionRe = /export const GUI_VERSION = '[0-9]+\.[0-9]+\.[0-9]+'/;
if (!guiVersionRe.test(constantsContent)) {
    console.error("错误: src/shared/constants.ts 中未匹配到 export const GUI_VERSION = 'x.y.z'，未做替换");
    process.exit(1);
}
constantsContent = constantsContent.replace(guiVersionRe, `export const GUI_VERSION = '${version}'`);
writeFileSync(constantsPath, constantsContent, 'utf-8');
console.log('  ✓ src/shared/constants.ts (GUI_VERSION)');

console.log(`\n版本号已同步到 ${version}`);

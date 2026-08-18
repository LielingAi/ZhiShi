/**
 * zsp-local — 加密插件（.zsp）制作工具链的本地子命令实现。
 *
 * spec: specs/tech_docs/encrypted_plugins_t1.md §5 / §5.1。
 *
 * 与 zhishi.ts 里其他命令的本质区别：**不走 sidecar**。init/pack/keygen/verify
 * 是纯本地密码学（密钥材料在 `~/.zspack/<publisher>/`，不进任何服务器），
 * app 不运行也必须能用，所以 zhishi.ts 在 ZHISHI_PORT 检查之前就拦截到本模块。
 *
 * 边界（spec §5.1）：管理已装插件走 sidecar（plugin install/list/remove 不变），
 * 制作插件走本地（本文件的四个函数）。
 *
 * 密码学原语全部来自 src/shared/zsp-crypto.ts——与 sidecar 安装侧共用同一份
 * 契约，签名/许可串构造两边逐字节一致。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'fs';

import { homedir } from 'os';

import { dirname, join, resolve, sep } from 'path';

import AdmZip from 'adm-zip';

import {
  ZSP_SCHEMA,
  ZspError,
  generatePublisherKeypair,
  pubkeyFromPem,
  publicKeyFromB64,
  encodeLicense,
  verifyLicense,
  newDek,
  encryptPayload,
  decryptPayload,
  sha256Hex,
  type ZspManifest,
} from '../shared/zsp-crypto';

import { sign, verify } from 'crypto';

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function zspackRoot(): string {
  return join(homedir(), '.zspack');
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/** chmod 在 Windows 上是尽力而为（可能抛错或静默无效），绝不让它打断主流程。 */
function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows: 无 POSIX 权限位语义，忽略。
  }
}

/** publisher 名直接拼路径——拒绝任何能跳出 ~/.zspack 的名字。 */
function assertSafePublisherName(name: string): void {
  if (!name || /[/\\]|\.\./.test(name)) {
    fail(`publisher 名不合法: "${name}"（不允许包含 / \\ 或 ..）`);
  }
}

interface DeksFile {
  [pluginId: string]: { dekId: string; dekHex: string };
}

function readDeks(deksPath: string): DeksFile {
  if (!existsSync(deksPath)) return {};
  try {
    return JSON.parse(readFileSync(deksPath, 'utf-8')) as DeksFile;
  } catch {
    fail(`deks.json 已损坏，无法解析: ${deksPath}`);
  }
}

/**
 * 解析本次操作使用哪个 publisher 身份：
 * --publisher 显式指定 → 用它；否则 ~/.zspack 下只有一个身份时自动选用，
 * 多个时要求显式指定（签名权必须无歧义）。
 */
function resolvePublisher(flags: Record<string, unknown>): { publisher: string; dir: string; privateKeyPem: string } {
  const root = zspackRoot();
  const requested = typeof flags.publisher === 'string' ? flags.publisher : undefined;

  let publisher: string;
  if (requested) {
    assertSafePublisherName(requested);
    publisher = requested;
  } else {
    const candidates = existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'key.pem')))
          .map((d) => d.name)
      : [];
    if (candidates.length === 0) {
      fail('还没有任何发布者身份。先运行: zhishi plugin init --publisher <name>');
    }
    if (candidates.length > 1) {
      fail(`存在多个发布者身份（${candidates.join(', ')}），请用 --publisher <name> 指定一个`);
    }
    publisher = candidates[0];
  }

  const dir = join(root, publisher);
  const keyPath = join(dir, 'key.pem');
  if (!existsSync(keyPath)) {
    fail(`找不到发布者 "${publisher}" 的私钥（${keyPath}）。先运行: zhishi plugin init --publisher ${publisher}`);
  }
  return { publisher, dir, privateKeyPem: readFileSync(keyPath, 'utf-8') };
}

/**
 * 签名对象（spec §2.1）：两份 sha256 的 32B 原始字节拼接——
 * sha256(manifest.json 原文) ‖ sha256(payload.enc)。sidecar 验签侧用同样构造，
 * 任何改动必须两边同步。
 */
function signaturePayload(manifestBytes: Buffer, payloadEnc: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(sha256Hex(manifestBytes), 'hex'),
    Buffer.from(sha256Hex(payloadEnc), 'hex'),
  ]);
}

// ---------------------------------------------------------------------------
// zhishi plugin init --publisher <name>
// ---------------------------------------------------------------------------

export function pluginInit(flags: Record<string, unknown>): void {
  const publisher = typeof flags.publisher === 'string' ? flags.publisher : '';
  if (!publisher) fail('plugin init 需要 --publisher <name>');
  assertSafePublisherName(publisher);

  const dir = join(zspackRoot(), publisher);
  const keyPath = join(dir, 'key.pem');
  if (existsSync(keyPath)) {
    // 私钥 = 签发权。已存在就拒绝覆盖——覆盖会让旧许可串全部失效，
    // 而误操作（重复 init）是最常见的覆盖原因。
    fail(`发布者 "${publisher}" 已初始化（${keyPath} 已存在）。私钥即签发权，不覆盖。`);
  }

  const { privateKeyPem, pubkeyB64 } = generatePublisherKeypair();

  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  writeFileSync(join(dir, 'pubkey.b64'), pubkeyB64, { mode: 0o600 });
  writeFileSync(join(dir, 'deks.json'), '{}\n', { mode: 0o600 });
  chmodBestEffort(keyPath, 0o600);
  chmodBestEffort(join(dir, 'pubkey.b64'), 0o600);
  chmodBestEffort(join(dir, 'deks.json'), 0o600);
  chmodBestEffort(dir, 0o700);

  console.log(`✓ 发布者身份已初始化: ${publisher}`);
  console.log(`  目录:   ${dir}`);
  console.log(`  公钥:   ${pubkeyB64}`);
  console.log('  公钥可公示；key.pem 是签发权，请勿泄露。');
}

// ---------------------------------------------------------------------------
// zhishi plugin pack [--dir <path>] [--new-dek] [--out <path>]
// ---------------------------------------------------------------------------

/** 打包时排除的目录名（任意层级）。 */
const PACK_EXCLUDE_DIRS = new Set(['dist', '.git', 'node_modules']);

/** 把整个插件目录递归打成 zip buffer，entry 用正斜杠相对路径。 */
function zipPluginDir(dir: string): Buffer {
  const zip = new AdmZip();
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && PACK_EXCLUDE_DIRS.has(entry.name)) continue;
      const entryAbs = join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(entryAbs);
      } else if (entry.isFile()) {
        const rel = resolve(entryAbs).slice(resolve(dir).length + 1).split(sep).join('/');
        zip.addFile(rel, readFileSync(entryAbs));
      }
    }
  };
  walk(dir);
  return zip.toBuffer();
}

export function pluginPack(flags: Record<string, unknown>): void {
  const dir = resolve(typeof flags.dir === 'string' ? flags.dir : '.');
  const pluginJsonPath = join(dir, '.claude-plugin', 'plugin.json');
  if (!existsSync(pluginJsonPath)) {
    fail(`缺少 ${pluginJsonPath}——不是合法的插件目录`);
  }
  let pluginJson: { name?: string; version?: string };
  try {
    pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8')) as { name?: string; version?: string };
  } catch {
    fail(`plugin.json 无法解析: ${pluginJsonPath}`);
  }
  const pluginId = pluginJson.name ?? '';
  const version = pluginJson.version ?? '';
  if (!pluginId || !version) fail(`plugin.json 缺少 name/version: ${pluginJsonPath}`);

  const { publisher, dir: publisherDir, privateKeyPem } = resolvePublisher(flags);

  // DEK：deks.json 里已有该 pluginId 且未传 --new-dek → 复用（对已购用户无需重发许可）；
  // 否则换新并记录。dekId 格式 <pluginId>-YYYYMMDD。
  const deksPath = join(publisherDir, 'deks.json');
  const deks = readDeks(deksPath);
  const existing = deks[pluginId];
  let dek: Buffer;
  let dekId: string;
  if (existing && !flags.newDek) {
    dek = Buffer.from(existing.dekHex, 'hex');
    dekId = existing.dekId;
  } else {
    dek = newDek();
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    dekId = `${pluginId}-${today}`;
    deks[pluginId] = { dekId, dekHex: dek.toString('hex') };
    writeFileSync(deksPath, JSON.stringify(deks, null, 2) + '\n', { mode: 0o600 });
    chmodBestEffort(deksPath, 0o600);
  }

  const zipBuffer = zipPluginDir(dir);
  const payloadEnc = encryptPayload(zipBuffer, dek);

  const manifest: ZspManifest = {
    schema: ZSP_SCHEMA,
    id: pluginId,
    version,
    publisher,
    publisherPubkey: pubkeyFromPem(privateKeyPem),
    encryption: { alg: 'AES-256-GCM', dekId },
    payloadHash: `sha256:${sha256Hex(payloadEnc)}`,
  };
  // manifestBytes 就是写进 .zsp 的原始字节——签名对它做 sha256，
  // 验签侧对 zip 里读出的同一份字节重算，必须逐字节一致。
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
  const signature = sign(null, signaturePayload(manifestBytes, payloadEnc), privateKeyPem);

  const zsp = new AdmZip();
  zsp.addFile('manifest.json', manifestBytes);
  zsp.addFile('payload.enc', payloadEnc);
  zsp.addFile('signature.sig', signature);

  const outPath = typeof flags.out === 'string'
    ? resolve(flags.out)
    : join(dir, 'dist', `${pluginId}-${version}.zsp`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, zsp.toBuffer());

  console.log(`✓ 已打包: ${outPath}`);
  console.log(`  插件:   ${pluginId} v${version}`);
  console.log(`  发布者: ${publisher}`);
  console.log(`  dekId:  ${dekId}${existing && !flags.newDek ? '（复用）' : '（新生成）'}`);
  console.log(`  下一步: 用 zhishi plugin keygen --plugin ${pluginId} 签发许可证`);
}

// ---------------------------------------------------------------------------
// zhishi plugin keygen --plugin <id> [-n N]
// ---------------------------------------------------------------------------

export function pluginKeygen(positional: string[], flags: Record<string, unknown>): void {
  const pluginId = (typeof flags.plugin === 'string' ? flags.plugin : positional[0]) ?? '';
  if (!pluginId) fail('plugin keygen 需要 --plugin <id>');

  const { dir, privateKeyPem } = resolvePublisher(flags);
  const deks = readDeks(join(dir, 'deks.json'));
  const entry = deks[pluginId];
  if (!entry) {
    fail(`deks.json 里没有插件 "${pluginId}" 的 DEK——先运行 zhishi plugin pack 打包该插件`);
  }

  // -n 经 shortFlagAliases 映射为 flags.count；--n 也兼容。
  const rawN = flags.count ?? flags.n;
  const n = rawN === undefined ? 1 : Number.parseInt(String(rawN), 10);
  if (!Number.isInteger(n) || n < 1) fail(`-n 需要正整数，收到: ${String(rawN)}`);

  const dek = Buffer.from(entry.dekHex, 'hex');
  for (let i = 0; i < n; i++) {
    console.log(encodeLicense(pluginId, dek, privateKeyPem));
  }
}

// ---------------------------------------------------------------------------
// zhishi plugin verify <pkg.zsp> --license <串>
// ---------------------------------------------------------------------------

export function pluginVerify(positional: string[], flags: Record<string, unknown>): void {
  const pkgPath = positional[0];
  if (!pkgPath) fail('plugin verify 需要 <pkg.zsp> 路径');
  const license = typeof flags.license === 'string' ? flags.license : '';
  if (!license) fail('plugin verify 需要 --license <许可串>');

  try {
    const absPath = resolve(pkgPath);
    if (!existsSync(absPath)) {
      throw new ZspError('PACKAGE_INVALID', `包不存在: ${absPath}`);
    }

    const zsp = new AdmZip(absPath);
    const manifestEntry = zsp.getEntry('manifest.json');
    const payloadEntry = zsp.getEntry('payload.enc');
    const signatureEntry = zsp.getEntry('signature.sig');
    if (!manifestEntry || !payloadEntry || !signatureEntry) {
      throw new ZspError('PACKAGE_INVALID', '不是合法的 .zsp 包（缺少 manifest.json / payload.enc / signature.sig）');
    }

    const manifestBytes = manifestEntry.getData();
    const payloadEnc = payloadEntry.getData();
    const signature = signatureEntry.getData();

    let manifest: ZspManifest;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf-8')) as ZspManifest;
    } catch {
      throw new ZspError('PACKAGE_INVALID', 'manifest.json 无法解析');
    }
    if (manifest.schema !== ZSP_SCHEMA || !manifest.id || !manifest.publisherPubkey) {
      throw new ZspError('PACKAGE_INVALID', 'manifest.json 字段不完整或 schema 未知');
    }

    // 校验链（spec §2.2）：许可串验签取 DEK → 解密（GCM tag 验完整性）
    // → 核对 payloadHash → 校包签名 → 解出的 zip 必须是合法插件目录。
    const dek = verifyLicense(license, manifest.id, manifest.publisherPubkey);
    const zipBuffer = decryptPayload(payloadEnc, dek);

    if (`sha256:${sha256Hex(payloadEnc)}` !== manifest.payloadHash) {
      throw new ZspError('PAYLOAD_CORRUPT', '包已损坏或被篡改（哈希不匹配）');
    }

    const sigOk = verify(
      null,
      signaturePayload(manifestBytes, payloadEnc),
      publicKeyFromB64(manifest.publisherPubkey),
      signature,
    );
    if (!sigOk) {
      throw new ZspError('PACKAGE_INVALID', '包签名无效——manifest 或 payload 被篡改');
    }

    let pluginJsonEntry;
    try {
      pluginJsonEntry = new AdmZip(zipBuffer).getEntry('.claude-plugin/plugin.json');
    } catch {
      throw new ZspError('PACKAGE_INVALID', 'payload 不是合法的 zip');
    }
    if (!pluginJsonEntry) {
      throw new ZspError('PACKAGE_INVALID', 'payload 缺少 .claude-plugin/plugin.json');
    }
    const pluginJson = JSON.parse(pluginJsonEntry.getData().toString('utf-8')) as { name?: string; version?: string };

    console.log(`✓ 验签+解密通过: ${pluginJson.name ?? manifest.id} v${pluginJson.version ?? manifest.version} 发布者: ${manifest.publisher}`);
  } catch (err) {
    if (err instanceof ZspError) {
      console.error(`[${err.code}] ${err.message}`);
    } else {
      console.error(`[PACKAGE_INVALID] ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 入口（zhishi.ts 在 ZHISHI_PORT 检查前调用）
// ---------------------------------------------------------------------------

export async function runZspLocal(action: string, positional: string[], flags: Record<string, unknown>): Promise<void> {
  switch (action) {
    case 'init':
      pluginInit(flags);
      return;
    case 'pack':
      pluginPack(flags);
      return;
    case 'keygen':
      pluginKeygen(positional, flags);
      return;
    case 'verify':
      pluginVerify(positional, flags);
      return;
    default:
      fail(`未知的 plugin 本地子命令: ${action}`);
  }
}

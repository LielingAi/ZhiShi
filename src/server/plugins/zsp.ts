/**

 * zsp.ts — 加密插件（.zsp）的验签 / 解密 / 落盘安装。

 * spec: specs/tech_docs/encrypted_plugins_t1.md。

 *

 * 校验链（spec §2.2）：

 *

 *   1. 解 .zsp 容器（zip）→ manifest.json / payload.enc / signature.sig

 *   2. manifest schema 校验（zsp/1 + 字段齐全 + id 是 kebab-case）

 *   3. verifyLicense：许可串验签（manifest.publisherPubkey）→ DEK

 *   4. sha256(payload.enc 密文) === manifest.payloadHash

 *   5. 包签名：verify(sha256(manifest原文) ‖ sha256(payload.enc)) ——

 *      与 CLI pack 侧（src/cli/zsp-local.ts signaturePayload）逐字节一致

 *   6. decryptPayload（AES-256-GCM，tag 验完整性）→ 插件目录 zip

 *   7. zip 内必须有 .claude-plugin/plugin.json 且 name === manifest.id

 *   8. 落盘：staging → rename → AppConfig 注册（参照 store.ts installPlugin）

 *   9. putPluginLicense 激活落库（memory.db plugin_licenses）

 *

 * 错误约定：包/许可问题一律抛 ZspError（中文 message + 机器可读 code，

 * UI 按 code 分行文案）；落盘/注册问题抛 PluginStoreError（沿用明文

 * 插件安装的错误族与 HTTP 状态码）。

 */



import { existsSync, renameSync } from 'fs';

import { join, resolve } from 'path';

import { randomUUID, verify } from 'crypto';



import AdmZip from 'adm-zip';



import {

  ZSP_SCHEMA,

  ZspError,

  verifyLicense,

  decryptPayload,

  sha256Hex,

  publicKeyFromB64,

  type ZspManifest,

} from '../../shared/zsp-crypto';

import { makePluginId, type PluginEntry } from '../../shared/types/plugin';

import { withConfigLock, type AdminAppConfig } from '../utils/admin-config';

import { putPluginLicense } from '../memory/store';

import type { ExtractedTree } from './tarball-fetcher';

import { getPluginsRoot, PluginStoreError, assertNameNotReserved } from './store';

import {

  analysePluginTree,

  writePluginToDisk,

  removeInstallPath,

  clearBrokenSymlinkAt,

  makeInstallPath,

  PluginInstallError,

} from './installer';

import { isPluginRootDir, PLUGIN_NAME_RE } from './manifest';



// -----------------------------------------------------------------------------

// .zsp 容器解析

// -----------------------------------------------------------------------------



const PAYLOAD_HASH_RE = /^sha256:[0-9a-f]{64}$/;



/** manifest.json 解析 + schema 校验。任何不符都抛 PACKAGE_INVALID。 */

function parseZspManifest(manifestBytes: Buffer): ZspManifest {

  let parsed: unknown;

  try {

    parsed = JSON.parse(manifestBytes.toString('utf-8'));

  } catch (err) {

    throw new ZspError('PACKAGE_INVALID', `manifest.json 无法解析：${(err as Error).message}`);

  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {

    throw new ZspError('PACKAGE_INVALID', 'manifest.json 必须是 JSON 对象');

  }

  const obj = parsed as Record<string, unknown>;

  if (obj.schema !== ZSP_SCHEMA) {

    throw new ZspError('PACKAGE_INVALID', `manifest.json schema 未知（应为 ${ZSP_SCHEMA}）`);

  }

  if (typeof obj.id !== 'string' || !obj.id || !PLUGIN_NAME_RE.test(obj.id)) {

    throw new ZspError('PACKAGE_INVALID', 'manifest.json::id 缺失或不是 kebab-case');

  }

  if (typeof obj.version !== 'string' || !obj.version) {

    throw new ZspError('PACKAGE_INVALID', 'manifest.json 缺少 version 字段');

  }

  if (typeof obj.publisher !== 'string' || !obj.publisher) {

    throw new ZspError('PACKAGE_INVALID', 'manifest.json 缺少 publisher 字段');

  }

  if (typeof obj.publisherPubkey !== 'string' || !obj.publisherPubkey) {

    throw new ZspError('PACKAGE_INVALID', 'manifest.json 缺少 publisherPubkey 字段');

  }

  const encryption = obj.encryption as Record<string, unknown> | undefined;

  if (!encryption || encryption.alg !== 'AES-256-GCM' || typeof encryption.dekId !== 'string' || !encryption.dekId) {

    throw new ZspError('PACKAGE_INVALID', 'manifest.json::encryption 不完整（alg 应为 AES-256-GCM）');

  }

  if (typeof obj.payloadHash !== 'string' || !PAYLOAD_HASH_RE.test(obj.payloadHash)) {

    throw new ZspError('PACKAGE_INVALID', 'manifest.json::payloadHash 缺失或格式不对（应为 sha256:hex）');

  }

  return parsed as ZspManifest;

}



/**

 * 解密后的 payload zip → ExtractedTree（喂给 installer 既有落盘路径）。

 * pack 侧把插件目录打在 zip 根部（正斜杠相对路径，无 wrapper root）；

 * 这里照搬 tarball-fetcher 的 traversal 防线（拒绝 .. / 绝对路径），

 * 真正的 zip-slip 拦截在下游 writeSkillFiles。

 */

function payloadZipToTree(zipBuffer: Buffer): ExtractedTree {

  let zip: AdmZip;

  try {

    zip = new AdmZip(zipBuffer);

  } catch (err) {

    throw new ZspError('PACKAGE_INVALID', `payload 不是合法的 zip：${(err as Error).message}`);

  }

  const files = new Map<string, Buffer>();

  for (const entry of zip.getEntries()) {

    if (entry.isDirectory) continue;

    const rel = entry.entryName.replace(/\\/g, '/');

    if (!rel || rel.startsWith('__MACOSX')) continue;

    if (rel.includes('..') || rel.startsWith('/')) continue;

    files.set(rel, entry.getData());

  }

  if (files.size === 0) {

    throw new ZspError('PACKAGE_INVALID', 'payload 是空的');

  }

  return { files, sourceUrl: 'zsp://payload' };

}



// -----------------------------------------------------------------------------

// 安装主流程

// -----------------------------------------------------------------------------



export interface ZspInstallResult {

  pluginId: string;

  name: string;

  version: string;

  publisher: string;

  installPath: string;

}



/**

 * 验签 + 解密 + 安装一个 .zsp 加密插件。

 *

 * ZspError 原样上抛（admin 层把 code 透传给 UI）；PluginStoreError 沿用

 * 明文插件的冲突语义（TARGET_EXISTS / ALREADY_INSTALLED 等 409）。

 */

export async function installZspPlugin(filePath: string, license: string): Promise<ZspInstallResult> {

  const absPath = resolve(filePath);

  if (!existsSync(absPath)) {

    throw new ZspError('PACKAGE_INVALID', `包不存在：${absPath}`);

  }



  // 1 — 解容器

  let zsp: AdmZip;

  try {

    zsp = new AdmZip(absPath);

  } catch (err) {

    throw new ZspError('PACKAGE_INVALID', `无法解压 .zsp 包：${(err as Error).message}`);

  }

  const manifestEntry = zsp.getEntry('manifest.json');

  const payloadEntry = zsp.getEntry('payload.enc');

  const signatureEntry = zsp.getEntry('signature.sig');

  if (!manifestEntry || !payloadEntry || !signatureEntry) {

    throw new ZspError('PACKAGE_INVALID', '不是合法的 .zsp 包（缺少 manifest.json / payload.enc / signature.sig）');

  }

  const manifestBytes = manifestEntry.getData();

  const payloadEnc = payloadEntry.getData();

  const signature = signatureEntry.getData();



  // 2 — manifest schema

  const manifest = parseZspManifest(manifestBytes);



  // 3 — 许可串验签 → DEK（ZspError 原样上抛）

  const dek = verifyLicense(license, manifest.id, manifest.publisherPubkey);



  // 4 — 密文哈希核对（篡改的密文到不了 GCM 那一步）

  if (`sha256:${sha256Hex(payloadEnc)}` !== manifest.payloadHash) {

    throw new ZspError('PAYLOAD_CORRUPT', '包已损坏或被篡改（哈希不匹配）');

  }



  // 5 — 包签名：sha256(manifest 原文) ‖ sha256(payload.enc)——与 pack 侧

  // zsp-local.ts 的 signaturePayload 构造逐字节一致，任何改动必须两边同步。

  const signedPayload = Buffer.concat([

    Buffer.from(sha256Hex(manifestBytes), 'hex'),

    Buffer.from(sha256Hex(payloadEnc), 'hex'),

  ]);

  const sigOk = verify(null, signedPayload, publicKeyFromB64(manifest.publisherPubkey), signature);

  if (!sigOk) {

    throw new ZspError('PAYLOAD_CORRUPT', '包签名无效——manifest 或 payload 被篡改');

  }



  // 6 — 解密 → 插件目录树（GCM tag 验完整性，失败抛 PAYLOAD_CORRUPT）

  const zipBuffer = decryptPayload(payloadEnc, dek);

  const tree = payloadZipToTree(zipBuffer);



  // 7 — payload 必须是单个合法插件，且 plugin.json::name === manifest.id

  // （否则许可串绑定的是 A 插件、装的却是 B 插件）。

  const analysis = analysePluginTree(tree);

  if (analysis.mode !== 'plugin') {

    throw new ZspError('PACKAGE_INVALID', 'payload 里未找到合法的 .claude-plugin/plugin.json');

  }

  const { manifest: pluginManifest, rootPath } = analysis;

  if (pluginManifest.name !== manifest.id) {

    throw new ZspError(

      'PACKAGE_INVALID',

      `payload 内插件名 "${pluginManifest.name}" 与 manifest.id "${manifest.id}" 不一致`,

    );

  }



  // 8 — 落盘 + 注册：staging → rename → AppConfig，参照 store.ts

  // installPlugin 的步骤 4-7（.zsp 没有 source-is-target 情形，包文件

  // 不可能是安装目录）。

  assertNameNotReserved(pluginManifest.name);

  const pluginsRoot = getPluginsRoot();

  const installPath = makeInstallPath(pluginsRoot, pluginManifest.name);

  const stagingPath = join(pluginsRoot, `.tmp-${randomUUID()}`);

  let staged = false;

  let movedIntoPlace = false;

  try {

    writePluginToDisk(stagingPath, tree, rootPath);

    staged = true;

    if (!isPluginRootDir(stagingPath)) {

      throw new PluginStoreError('写盘后未在目标目录找到 plugin.json', 'POST_WRITE_INVALID', 500);

    }

    const entry: PluginEntry = {

      id: makePluginId(pluginManifest.name, 'local'),

      name: pluginManifest.name,

      source: 'local',

      // 记录包来源便于排查；.zsp 不支持 reinstall，该字段仅作 provenance。

      sourceUrl: `zsp://${absPath}`,

      installPath,

      version: pluginManifest.version ?? manifest.version,

      description: pluginManifest.description,

      author: pluginManifest.author?.name,

      homepage: pluginManifest.homepage,

      repository: pluginManifest.repository,

      license: pluginManifest.license,

      installedAt: new Date().toISOString(),

    };

    await withConfigLock(async cfg => {

      const next: AdminAppConfig = { ...cfg };

      const list = (cfg.plugins as PluginEntry[] | undefined)?.slice() ?? [];

      if (list.some(p => p.name === pluginManifest.name)) {

        throw new PluginStoreError(

          `插件 "${pluginManifest.name}" 已被并发安装`,

          'ALREADY_INSTALLED',

          409,

        );

      }

      try {

        clearBrokenSymlinkAt(installPath);

        if (existsSync(installPath)) {

          throw new PluginStoreError(

            `目录已存在：${installPath}。请先卸载同名插件或手动清理`,

            'TARGET_EXISTS',

            409,

          );

        }

        renameSync(stagingPath, installPath);

        staged = false; // staging dir is gone — don't double-GC

        movedIntoPlace = true; // installPath now exists; roll back if commit fails

      } catch (err) {

        if (err instanceof PluginStoreError) throw err;

        throw new PluginStoreError(

          `重命名安装目录失败：${(err as Error).message}`,

          'RENAME_FAILED',

          500,

        );

      }

      list.push(entry);

      next.plugins = list;

      const enabled = { ...((cfg.enabledPlugins as Record<string, boolean> | undefined) ?? {}) };

      enabled[entry.id] = true; // new installs default to enabled

      next.enabledPlugins = enabled;

      return next;

    });

    // 9 — 激活落库（config 提交成功后才写，失败不留半激活状态）。

    // license_hash 存的是许可串本身的 sha256，便于审计/去重而不留原文。

    putPluginLicense({

      pluginId: entry.id,

      publisher: manifest.publisher,

      publisherPubkey: manifest.publisherPubkey,

      dek,

      licenseHash: sha256Hex(Buffer.from(license.trim(), 'utf-8')),

      activatedAt: Date.now(),

    });

    return {

      pluginId: entry.id,

      name: entry.name,

      version: entry.version ?? manifest.version,

      publisher: manifest.publisher,

      installPath,

    };

  } catch (err) {

    // 与 installPlugin 相同的回滚：staging 未 rename → 清 staging；

    // rename 成功但 config 未提交 → 清 installPath，避免 TARGET_EXISTS 死锁。

    if (staged) {

      try { removeInstallPath(stagingPath); } catch { /* best-effort */ }

    }

    if (movedIntoPlace) {

      try { removeInstallPath(installPath); } catch { /* best-effort */ }

    }

    if (err instanceof PluginInstallError) {

      throw new PluginStoreError(err.message, err.code, err.statusCode);

    }

    throw err;

  }

}


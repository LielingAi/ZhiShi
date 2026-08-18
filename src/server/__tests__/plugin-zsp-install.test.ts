/**

 * .zsp 加密插件安装链路测试（specs/tech_docs/encrypted_plugins_t1.md）。

 *

 * 用 zsp-crypto 原语现签现包（与 CLI pack 侧同一条构造链），覆盖：

 *

 *   - 自签自装端到端（验签 → 解密 → 落盘 → AppConfig 注册 → 许可落库）

 *   - LICENSE_SIG_INVALID（许可串不是 manifest 发布者签发）

 *   - LICENSE_PLUGIN_MISMATCH（许可串属于别的插件）

 *   - PAYLOAD_CORRUPT（密文被篡改 / manifest 被篡改导致包签名失效）

 *   - TARGET_EXISTS（同名目录冲突，沿用明文插件的 409 语义）

 *

 * Stateful（真实 fs + config.json 锁 + memory.db sqlite），跑 serial 池。

 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { sign } from 'node:crypto';

import AdmZip from 'adm-zip';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';



import {

  ZSP_SCHEMA,

  ZspError,

  generatePublisherKeypair,

  newDek,

  encryptPayload,

  encodeLicense,

  sha256Hex,

} from '../../shared/zsp-crypto';

import { installZspPlugin } from '../plugins/zsp';

import { listInstalledPlugins, PluginStoreError } from '../plugins/store';

import { getPluginLicense, deletePluginLicense, resetMemoryStoreForTest } from '../memory/store';



// -----------------------------------------------------------------------------

// .zsp 构造工具（与 src/cli/zsp-local.ts 的 pack 链逐字节一致）

// -----------------------------------------------------------------------------



interface BuiltZsp {

  zspPath: string;

  license: string;

  publisher: string;

}



interface BuildOpts {

  pluginId?: string;

  /** 许可串签给另一个插件 id（触发 LICENSE_PLUGIN_MISMATCH） */

  licensePluginId?: string;

  /** 许可串用另一把私钥签（触发 LICENSE_SIG_INVALID） */

  licenseKeyPem?: string;

  /** 篡改 payload.enc 最后一个字节（触发 payloadHash 不匹配） */

  tamperPayload?: boolean;

  /** 签名后篡改 manifest（触发包签名失效） */

  tamperManifest?: (m: Record<string, unknown>) => void;

}



function buildPluginZipBuffer(pluginId: string): Buffer {

  const zip = new AdmZip();

  zip.addFile(

    '.claude-plugin/plugin.json',

    Buffer.from(JSON.stringify({ name: pluginId, version: '1.0.0', description: 'zsp test' }), 'utf-8'),

  );

  zip.addFile('commands/hi.md', Buffer.from('# hi\n', 'utf-8'));

  return zip.toBuffer();

}



function buildZsp(home: string, opts: BuildOpts = {}): BuiltZsp {

  const { privateKeyPem, pubkeyB64 } = generatePublisherKeypair();

  const pluginId = opts.pluginId ?? 'zsp-demo';

  const dek = newDek();

  const payloadEnc = encryptPayload(buildPluginZipBuffer(pluginId), dek);

  if (opts.tamperPayload) {

    payloadEnc[payloadEnc.length - 1] = payloadEnc[payloadEnc.length - 1] ^ 0xff;

  }

  const manifest: Record<string, unknown> = {

    schema: ZSP_SCHEMA,

    id: pluginId,

    version: '1.0.0',

    publisher: 'test-publisher',

    publisherPubkey: pubkeyB64,

    encryption: { alg: 'AES-256-GCM', dekId: 'k1' },

    payloadHash: `sha256:${sha256Hex(payloadEnc)}`,

  };

  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');

  // 签名对象：sha256(manifest 原文) ‖ sha256(payload.enc)（与 pack 侧一致）

  const signedPayload = Buffer.concat([

    Buffer.from(sha256Hex(manifestBytes), 'hex'),

    Buffer.from(sha256Hex(payloadEnc), 'hex'),

  ]);

  const signature = sign(null, signedPayload, privateKeyPem);

  let finalManifestBytes = manifestBytes;

  if (opts.tamperManifest) {

    const m2 = JSON.parse(manifestBytes.toString('utf-8')) as Record<string, unknown>;

    opts.tamperManifest(m2);

    finalManifestBytes = Buffer.from(JSON.stringify(m2, null, 2), 'utf-8');

  }

  const zsp = new AdmZip();

  zsp.addFile('manifest.json', finalManifestBytes);

  zsp.addFile('payload.enc', payloadEnc);

  zsp.addFile('signature.sig', signature);

  const zspPath = join(home, `${pluginId}.zsp`);

  writeFileSync(zspPath, zsp.toBuffer());

  const license = encodeLicense(opts.licensePluginId ?? pluginId, dek, opts.licenseKeyPem ?? privateKeyPem);

  return { zspPath, license, publisher: 'test-publisher' };

}



async function expectZspCode(promise: Promise<unknown>, code: string): Promise<void> {

  try {

    await promise;

  } catch (err) {

    expect(err).toBeInstanceOf(ZspError);

    expect((err as ZspError).code).toBe(code);

    return;

  }

  expect.unreachable(`expected ZspError ${code}`);

}



// -----------------------------------------------------------------------------

// 测试

// -----------------------------------------------------------------------------



describe('plugin install — encrypted .zsp', () => {

  let home: string;

  let savedHome: string | undefined;

  let savedUserProfile: string | undefined;



  beforeEach(() => {

    home = mkdtempSync(join(tmpdir(), 'zhishi-plugin-zsp-'));

    savedHome = process.env.HOME;

    savedUserProfile = process.env.USERPROFILE;

    // getHomeDirOrNull() reads HOME (unix) / USERPROFILE (win) at call time.

    process.env.HOME = home;

    process.env.USERPROFILE = home;

    const zhishi = join(home, '.zhishi');

    mkdirSync(zhishi, { recursive: true });

    // Seed an empty config so withConfigLock has a file to lock + rewrite.

    writeFileSync(join(zhishi, 'config.json'), JSON.stringify({}, null, 2), 'utf-8');

  });



  afterEach(() => {

    // 先关 sqlite（WAL 锁随之释放）再删临时 HOME，否则 Windows 上 rm 失败。

    resetMemoryStoreForTest();

    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;

    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;

    rmSync(home, { recursive: true, force: true });

  });



  it('自签自装端到端：验签解密落盘 + AppConfig 注册 + 许可落库 + 列表带激活信息', async () => {

    const { zspPath, license, publisher } = buildZsp(home);

    const result = await installZspPlugin(zspPath, license);

    expect(result.pluginId).toBe('zsp-demo@local');

    expect(result.name).toBe('zsp-demo');

    expect(result.version).toBe('1.0.0');

    expect(result.publisher).toBe(publisher);

    // 落盘：plugins/<name>/ 下是解密后的插件目录

    const pluginJsonPath = join(result.installPath, '.claude-plugin', 'plugin.json');

    expect(existsSync(pluginJsonPath)).toBe(true);

    expect(JSON.parse(readFileSync(pluginJsonPath, 'utf-8')).name).toBe('zsp-demo');

    expect(existsSync(join(result.installPath, 'commands', 'hi.md'))).toBe(true);

    // 许可落库（plugin_licenses）

    const rec = getPluginLicense('zsp-demo@local');

    expect(rec).toBeDefined();

    expect(rec?.publisher).toBe(publisher);

    expect(rec?.dek.length).toBe(32);

    expect(rec?.activatedAt).toBeGreaterThan(0);

    // 列表联查：license 从 SPDX 字符串变成激活信息对象

    const item = listInstalledPlugins().find(p => p.id === 'zsp-demo@local');

    expect(item?.enabled).toBe(true);

    expect(item?.license).toMatchObject({ publisher });

    // 卸载联动的基础：deletePluginLicense 幂等删除

    deletePluginLicense('zsp-demo@local');

    expect(getPluginLicense('zsp-demo@local')).toBeUndefined();

  });



  it('许可串不是 manifest 发布者签发 → LICENSE_SIG_INVALID', async () => {

    const wrongPublisher = generatePublisherKeypair();

    const { zspPath, license } = buildZsp(home, { licenseKeyPem: wrongPublisher.privateKeyPem });

    await expectZspCode(installZspPlugin(zspPath, license), 'LICENSE_SIG_INVALID');

    // 失败不留残：未注册、未落盘、未激活

    expect(listInstalledPlugins()).toHaveLength(0);

    expect(getPluginLicense('zsp-demo@local')).toBeUndefined();

  });



  it('许可串属于别的插件 → LICENSE_PLUGIN_MISMATCH', async () => {

    const { zspPath, license } = buildZsp(home, { licensePluginId: 'other-plugin' });

    await expectZspCode(installZspPlugin(zspPath, license), 'LICENSE_PLUGIN_MISMATCH');

  });



  it('payload.enc 被篡改 → PAYLOAD_CORRUPT（哈希不匹配）', async () => {

    const { zspPath, license } = buildZsp(home, { tamperPayload: true });

    await expectZspCode(installZspPlugin(zspPath, license), 'PAYLOAD_CORRUPT');

  });



  it('manifest 签后被篡改 → PAYLOAD_CORRUPT（包签名失效）', async () => {

    const { zspPath, license } = buildZsp(home, {

      tamperManifest: m => {

        m.publisher = 'evil-publisher';

      },

    });

    await expectZspCode(installZspPlugin(zspPath, license), 'PAYLOAD_CORRUPT');

  });



  it('许可串格式不对 → LICENSE_MALFORMED', async () => {

    const { zspPath } = buildZsp(home);

    await expectZspCode(installZspPlugin(zspPath, 'NOT-A-LICENSE'), 'LICENSE_MALFORMED');

  });



  it('同名插件已安装 → PluginStoreError ALREADY_INSTALLED（沿用明文冲突语义）', async () => {

    const first = buildZsp(home);

    await installZspPlugin(first.zspPath, first.license);

    const second = buildZsp(home);

    let caught: unknown;

    try {

      await installZspPlugin(second.zspPath, second.license);

    } catch (err) {

      caught = err;

    }

    expect(caught).toBeInstanceOf(PluginStoreError);

    expect((caught as PluginStoreError).code).toBe('ALREADY_INSTALLED');

    // 第一次安装的许可行仍在（第二次失败没有清掉它）

    expect(getPluginLicense('zsp-demo@local')).toBeDefined();

  });



  it('安装目录被外部预占（无 config 行）→ PluginStoreError TARGET_EXISTS', async () => {

    const orphan = join(home, '.zhishi', 'plugins', 'zsp-demo');

    mkdirSync(orphan, { recursive: true });

    const { zspPath, license } = buildZsp(home);

    let caught: unknown;

    try {

      await installZspPlugin(zspPath, license);

    } catch (err) {

      caught = err;

    }

    expect(caught).toBeInstanceOf(PluginStoreError);

    expect((caught as PluginStoreError).code).toBe('TARGET_EXISTS');

  });

});


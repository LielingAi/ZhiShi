/**
 * zsp-crypto — 加密插件（.zsp）的共享密码学契约（specs/tech_docs/encrypted_plugins_t1.md）。
 *
 * CLI（plugin pack/keygen/verify，本地模式）与 sidecar（验签解密安装）共用。
 * 只用 node:crypto + 纯函数，无任何三方依赖。
 *
 * 许可串格式（≈165 字符，可粘贴）：
 *   payload   = 0x01 ‖ sha256(pluginId)[0..4] ‖ DEK(32B)          // 37B
 *   signature = ed25519.sign(publisher 私钥, payload)             // 64B
 *   license   = "ZSP1-" + base32(payload ‖ signature) 每 5 字符分组
 *
 * payload.enc 格式：iv(12B) ‖ tag(16B) ‖ AES-256-GCM(DEK) 密文。
 */

import { createHash, createPublicKey, generateKeyPairSync, sign, verify, createCipheriv, createDecipheriv, randomBytes, KeyObject } from 'crypto';

export const ZSP_LICENSE_PREFIX = 'ZSP1-';
export const ZSP_SCHEMA = 'zsp/1';
export const DEK_BYTES = 32;
export const LICENSE_PAYLOAD_BYTES = 1 + 4 + DEK_BYTES; // 37
export const ED25519_SIG_BYTES = 64;

export interface ZspManifest {
  schema: typeof ZSP_SCHEMA;
  id: string;
  version: string;
  publisher: string;
  publisherPubkey: string; // base64(raw 32B ed25519 pk)
  encryption: { alg: 'AES-256-GCM'; dekId: string };
  payloadHash: string; // "sha256:hex"，对 payload.enc 密文
}

/** 带机器可读 code 的错误——UI 据此分行文案。 */
export class ZspError extends Error {
  constructor(
    public code:
      | 'PACKAGE_INVALID'
      | 'PAYLOAD_CORRUPT'
      | 'LICENSE_MALFORMED'
      | 'LICENSE_SIG_INVALID'
      | 'LICENSE_PLUGIN_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'ZspError';
  }
}

// ===== base32（RFC4648 大写、无 padding） =====

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase()) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new ZspError('LICENSE_MALFORMED', `invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ===== 密钥对（publisher 身份） =====

export function generatePublisherKeypair(): { publicKeyPem: string; privateKeyPem: string; pubkeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKeyPem, privateKeyPem, pubkeyB64: pubkeyFromPem(publicKeyPem) };
}

/** 从 SPKI PEM 导出 raw 32B 公钥的 base64（manifest 里的形态）。 */
export function pubkeyFromPem(pem: string): string {
  return createPublicKey(pem).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
}

/** 从 base64(raw 32B) 重建 SPKI 公钥（验签侧只有 manifest 里的 b64）。 */
export function publicKeyFromB64(b64: string): KeyObject {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new ZspError('PACKAGE_INVALID', 'publisherPubkey is not a raw ed25519 key');
  // Ed25519 SPKI DER 前缀（RFC 8410）
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: der, type: 'spki', format: 'der' });
}

// ===== 许可串 =====

export function hashPluginId(pluginId: string): Buffer {
  return createHash('sha256').update(pluginId, 'utf-8').digest().subarray(0, 4);
}

function group5(s: string): string {
  return s.replace(/.{5}(?=.)/g, '$&-');
}

/** 签发许可串（publisher 侧）。 */
export function encodeLicense(pluginId: string, dek: Buffer, privateKeyPem: string): string {
  if (dek.length !== DEK_BYTES) throw new ZspError('PACKAGE_INVALID', `DEK must be ${DEK_BYTES} bytes`);
  const payload = Buffer.concat([Buffer.from([0x01]), hashPluginId(pluginId), dek]);
  const signature = sign(null, payload, privateKeyPem);
  return ZSP_LICENSE_PREFIX + group5(base32Encode(Buffer.concat([payload, signature])));
}

/** 解析许可串结构（不验签）。 */
export function decodeLicense(license: string): { pluginIdHash: Buffer; dek: Buffer; signature: Buffer } {
  const normalized = license.trim().toUpperCase();
  if (!normalized.startsWith(ZSP_LICENSE_PREFIX)) {
    throw new ZspError('LICENSE_MALFORMED', '许可串格式不对——应以 ZSP1- 开头');
  }
  const body = normalized.slice(ZSP_LICENSE_PREFIX.length).replace(/-/g, '');
  let raw: Buffer;
  try {
    raw = base32Decode(body);
  } catch (err) {
    if (err instanceof ZspError) throw new ZspError('LICENSE_MALFORMED', '许可串含非法字符');
    throw err;
  }
  if (raw.length !== LICENSE_PAYLOAD_BYTES + ED25519_SIG_BYTES) {
    throw new ZspError('LICENSE_MALFORMED', '许可串长度不对（可能被截断）');
  }
  if (raw[0] !== 0x01) {
    throw new ZspError('LICENSE_MALFORMED', '许可串版本未知');
  }
  return {
    pluginIdHash: raw.subarray(1, 5),
    dek: raw.subarray(5, LICENSE_PAYLOAD_BYTES),
    signature: raw.subarray(LICENSE_PAYLOAD_BYTES),
  };
}

/**
 * 完整校验链（安装侧）：格式 → pluginId 匹配 → publisher 公钥验签 → 返回 DEK。
 * 验签对象与 encodeLicense 的 payload 完全一致。
 */
export function verifyLicense(license: string, pluginId: string, publisherPubkeyB64: string): Buffer {
  const { pluginIdHash, dek, signature } = decodeLicense(license);
  if (!pluginIdHash.equals(hashPluginId(pluginId))) {
    throw new ZspError('LICENSE_PLUGIN_MISMATCH', '这张许可证不属于这个插件');
  }
  const payload = Buffer.concat([Buffer.from([0x01]), pluginIdHash, dek]);
  const ok = verify(null, payload, publicKeyFromB64(publisherPubkeyB64), signature);
  if (!ok) {
    throw new ZspError('LICENSE_SIG_INVALID', '许可证签名无效——不是该发布者签发');
  }
  return dek;
}

// ===== payload 加解密（AES-256-GCM） =====

export function newDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

export function encryptPayload(plain: Buffer, dek: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

export function decryptPayload(payloadEnc: Buffer, dek: Buffer): Buffer {
  if (payloadEnc.length < 28) throw new ZspError('PAYLOAD_CORRUPT', 'payload too short');
  const iv = payloadEnc.subarray(0, 12);
  const tag = payloadEnc.subarray(12, 28);
  const encrypted = payloadEnc.subarray(28);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new ZspError('PAYLOAD_CORRUPT', '包已损坏或被篡改（解密校验失败）');
  }
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 安全研究员版 P2 V7 — 最小 ISO9660 镜像生成器（纯函数，零依赖）.
 *
 * 用途：给 cloud-init NoCloud 造 `cidata` seed ISO（user-data / meta-data）。
 * NoCloud 的硬约束：卷标必须是 `cidata`，文件名是小写带连字符——纯 ISO9660
 * Level 1（8.3 大写）放不下，所以镜像必须带 Joliet 补充卷描述符（SVD，
 * escape sequences %/@ %/C %/E，文件名 UCS-2BE 编码）。
 *
 * 镜像布局（sector = 2048，扁平根目录，无子目录）：
 *
 *   0-15   系统区（全零）
 *   16     PVD（type 1，文件名放安全大写映射 USER_DAT.;1）
 *   17     SVD（type 2，Joliet，文件名放真实名 user-data）
 *   18     卷描述符终止符（type 255）
 *   19/20  PVD path table（L 小端 / M 大端，各仅根目录一条）
 *   21/22  SVD path table（L / M）
 *   23     PVD 目录数据（. .. 文件记录）
 *   24     SVD 目录数据
 *   25+    文件内容区（每个文件按 sector 对齐）
 *
 * 双端序字段（733/723）两端都写。附 parseIso9660Files 从 Joliet 树读回
 * 文件清单——既是自洽性校验，也是单测抓手。
 */

const SECTOR_SIZE = 2048;

const PVD_SECTOR = 16;
const SVD_SECTOR = 17;
const TERMINATOR_SECTOR = 18;
const PVD_L_PT_SECTOR = 19;
const PVD_M_PT_SECTOR = 20;
const SVD_L_PT_SECTOR = 21;
const SVD_M_PT_SECTOR = 22;
const PVD_DIR_SECTOR = 23;
const SVD_DIR_SECTOR = 24;
const DATA_START_SECTOR = 25;

/** Joliet escape sequences（UCS-2 Level 3）：%/@ %/C %/E + 空格填充到 32 字节。 */
const JOLIET_ESCAPE_SEQUENCES = Buffer.from([
  0x25, 0x2f, 0x40, 0x25, 0x2f, 0x43, 0x25, 0x2f, 0x45,
  0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
  0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
  0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
]);

export interface IsoInputFile {
  /** 真实文件名（Joliet 树原样放；PVD 树放 8.3 大写映射）。 */
  name: string;
  content: Buffer;
}

export interface IsoBuildInput {
  /** 卷标（NoCloud 要求 cidata；PVD 里大写化，Joliet 里原样）。 */
  volumeId: string;
  files: IsoInputFile[];
}

// ---------------------------------------------------------------------------
// 底层编码助手
// ---------------------------------------------------------------------------

/** 733：4 字节小端 + 4 字节大端，两端都写。 */
function writeBothEndian32(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt32LE(value, offset);
  buf.writeUInt32BE(value, offset + 4);
}

/** 723：2 字节小端 + 2 字节大端。 */
function writeBothEndian16(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt16LE(value, offset);
  buf.writeUInt16BE(value, offset + 2);
}

/** UCS-2BE 编码（Joliet 文件名/卷标）。 */
function encodeUcs2Be(text: string): Buffer {
  const out = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    out.writeUInt16BE(text.charCodeAt(i), i * 2);
  }
  return out;
}

/** UCS-2BE 解码（parseIso9660Files 用）。 */
function decodeUcs2Be(buf: Buffer): string {
  let out = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out += String.fromCharCode(buf.readUInt16BE(i));
  }
  return out;
}

/**
 * PVD 树的安全文件名：ISO9660 Level 1（d-characters：A-Z 0-9 _），8.3 +
 * ";1" 版本号。非法字符替换为 '_'，主干截 8、扩展截 3。
 */
export function toIsoLevel1Name(name: string): string {
  const sanitize = (s: string, max: number) =>
    s.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, max);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return `${sanitize(stem, 8)}.${sanitize(ext, 3)};1`;
}

// ---------------------------------------------------------------------------
// 目录记录 / path table / 卷描述符
// ---------------------------------------------------------------------------

interface DirRecordSpec {
  extent: number;
  size: number;
  /** 2 = 目录，0 = 文件。 */
  flags: number;
  fileId: Buffer;
}

/**
 * 目录记录（ECMA-119 9.1）。记录长度 = 33 + LEN_FI + padding（LEN_FI 为偶
 * 数时补 1 字节使总长为偶）。录制日期写固定值（2026-01-01）保证输出确定。
 */
function buildDirRecord(spec: DirRecordSpec): Buffer {
  const pad = spec.fileId.length % 2 === 0 ? 1 : 0;
  const length = 33 + spec.fileId.length + pad;
  const rec = Buffer.alloc(length);
  rec[0] = length;
  rec.writeUInt32LE(spec.extent, 2);
  rec.writeUInt32BE(spec.extent, 6);
  rec.writeUInt32LE(spec.size, 10);
  rec.writeUInt32BE(spec.size, 14);
  rec[18] = 126; // 2026（自 1900 起）
  rec[19] = 1;
  rec[20] = 1;
  rec[25] = spec.flags;
  rec.writeUInt16LE(1, 28); // volume sequence number（723）
  rec.writeUInt16BE(1, 30);
  rec[32] = spec.fileId.length;
  spec.fileId.copy(rec, 33);
  return rec;
}

/** 根目录自指记录（file id 0x00）。 */
function rootDirRecord(extent: number, size: number): Buffer {
  return buildDirRecord({ extent, size, flags: 2, fileId: Buffer.from([0x00]) });
}

/** path table 只有根目录一条（10 字节）；bigEndian 切换 M 表。 */
function buildPathTable(dirExtent: number, bigEndian: boolean): Buffer {
  const table = Buffer.alloc(10);
  table[0] = 1; // LEN_DI（根目录标识符长 1）
  table[1] = 0; // 扩展属性记录长度
  if (bigEndian) {
    table.writeUInt32BE(dirExtent, 2);
    table.writeUInt16BE(1, 6); // 父目录编号（根的父是自己）
  } else {
    table.writeUInt32LE(dirExtent, 2);
    table.writeUInt16LE(1, 6);
  }
  table[8] = 0x00; // 根目录标识符
  return table;
}

const PATH_TABLE_SIZE = 10;

interface VolumeDescriptorSpec {
  /** 1 = PVD，2 = Joliet SVD。 */
  type: 1 | 2;
  volumeId: string;
  volumeSpaceSize: number;
  /** 本套描述符指向的目录/path table 位置。 */
  dirExtent: number;
  dirSize: number;
  lPathTableExtent: number;
  mPathTableExtent: number;
  rootRecord: Buffer;
}

/** PVD/SVD 公共骨架（ECMA-119 8.4/8.5），差异在 escape sequences 与编码。 */
function buildVolumeDescriptor(spec: VolumeDescriptorSpec): Buffer {
  const vd = Buffer.alloc(SECTOR_SIZE);
  vd[0] = spec.type;
  vd.write('CD001', 1, 'ascii');
  vd[6] = 1; // 版本
  vd.fill(0x20, 8, 40); // system id（a-characters，空格填充）

  // volume id（32 字节）：PVD 大写 d-characters；SVD UCS-2BE
  if (spec.type === 2) {
    const encoded = encodeUcs2Be(spec.volumeId.slice(0, 16));
    encoded.copy(vd, 32);
    for (let p = 32 + encoded.length; p + 1 < 64; p += 2) {
      vd[p] = 0x00;
      vd[p + 1] = 0x20; // UCS-2 空格填充
    }
  } else {
    const safe = spec.volumeId.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 32);
    vd.write(safe.padEnd(32, ' '), 32, 'ascii');
  }

  writeBothEndian32(vd, 80, spec.volumeSpaceSize);
  if (spec.type === 2) {
    JOLIET_ESCAPE_SEQUENCES.copy(vd, 88); // SVD 标志：Joliet Level 3
  }
  writeBothEndian16(vd, 120, 1); // volume set size
  writeBothEndian16(vd, 124, 1); // volume sequence number
  writeBothEndian16(vd, 128, SECTOR_SIZE); // logical block size
  writeBothEndian32(vd, 132, PATH_TABLE_SIZE);
  vd.writeUInt32LE(spec.lPathTableExtent, 140); // 711
  vd.writeUInt32LE(0, 144); // 可选 L 表：无
  vd.writeUInt32BE(spec.mPathTableExtent, 148); // 712
  vd.writeUInt32BE(0, 152); // 可选 M 表：无
  spec.rootRecord.copy(vd, 156); // 根目录记录（34 字节）
  vd[881] = 1; // file structure version
  return vd;
}

// ---------------------------------------------------------------------------
// 镜像生成
// ---------------------------------------------------------------------------

/**
 * 生成最小 ISO9660 + Joliet 镜像。扁平根目录；files 顺序即目录记录顺序。
 * 返回完整镜像 Buffer（长度为 2048 的整数倍）。
 */
export function buildIso9660(input: IsoBuildInput): Buffer {
  if (!input.volumeId.trim()) {
    throw new Error('volumeId 不能为空（NoCloud 要求 cidata）');
  }
  const names = new Set<string>();
  for (const file of input.files) {
    if (!file.name.trim()) throw new Error('ISO 内文件名不能为空');
    if (file.name.includes('/') || file.name.includes('\\')) {
      throw new Error(`不支持子目录文件："${file.name}"（生成器只造扁平根目录）`);
    }
    if (names.has(file.name)) throw new Error(`文件名重复："${file.name}"`);
    names.add(file.name);
  }

  // 文件 extent：从 DATA_START_SECTOR 起按 sector 对齐；空文件占 0 个 sector
  //（extent 落在下一个可用 sector，长度 0，合法）。
  let nextDataSector = DATA_START_SECTOR;
  const placements = input.files.map((file) => {
    const sectors = Math.ceil(file.content.length / SECTOR_SIZE);
    const extent = nextDataSector;
    nextDataSector += sectors;
    return { file, extent };
  });
  const volumeSpaceSize = nextDataSector;

  // 两套目录数据
  const pvdRecords: Buffer[] = [];
  const svdRecords: Buffer[] = [];
  for (const { file, extent } of placements) {
    pvdRecords.push(buildDirRecord({
      extent,
      size: file.content.length,
      flags: 0,
      fileId: Buffer.from(toIsoLevel1Name(file.name), 'ascii'),
    }));
    svdRecords.push(buildDirRecord({
      extent,
      size: file.content.length,
      flags: 0,
      fileId: encodeUcs2Be(`${file.name};1`),
    }));
  }
  const buildDirSector = (extent: number, records: Buffer[]): { data: Buffer; size: number } => {
    // 目录 size 字段按 sector 对齐后的占用长度写（含尾部零填充，常规 ISO 写法）
    const recordBytes = (34 + 34) + records.reduce((sum, r) => sum + r.length, 0);
    const size = Math.max(SECTOR_SIZE, Math.ceil(recordBytes / SECTOR_SIZE) * SECTOR_SIZE);
    const data = Buffer.alloc(size);
    let offset = 0;
    rootDirRecord(extent, size).copy(data, offset);
    offset += 34;
    buildDirRecord({ extent, size, flags: 2, fileId: Buffer.from([0x01]) }).copy(data, offset);
    offset += 34;
    for (const rec of records) {
      rec.copy(data, offset);
      offset += rec.length;
    }
    return { data, size };
  };
  const pvdDir = buildDirSector(PVD_DIR_SECTOR, pvdRecords);
  const svdDir = buildDirSector(SVD_DIR_SECTOR, svdRecords);

  const image = Buffer.alloc(volumeSpaceSize * SECTOR_SIZE);

  // 卷描述符
  buildVolumeDescriptor({
    type: 1,
    volumeId: input.volumeId,
    volumeSpaceSize,
    dirExtent: PVD_DIR_SECTOR,
    dirSize: pvdDir.size,
    lPathTableExtent: PVD_L_PT_SECTOR,
    mPathTableExtent: PVD_M_PT_SECTOR,
    rootRecord: rootDirRecord(PVD_DIR_SECTOR, pvdDir.size),
  }).copy(image, PVD_SECTOR * SECTOR_SIZE);
  buildVolumeDescriptor({
    type: 2,
    volumeId: input.volumeId,
    volumeSpaceSize,
    dirExtent: SVD_DIR_SECTOR,
    dirSize: svdDir.size,
    lPathTableExtent: SVD_L_PT_SECTOR,
    mPathTableExtent: SVD_M_PT_SECTOR,
    rootRecord: rootDirRecord(SVD_DIR_SECTOR, svdDir.size),
  }).copy(image, SVD_SECTOR * SECTOR_SIZE);

  // 终止符
  const terminator = Buffer.alloc(SECTOR_SIZE);
  terminator[0] = 255;
  terminator.write('CD001', 1, 'ascii');
  terminator[6] = 1;
  terminator.copy(image, TERMINATOR_SECTOR * SECTOR_SIZE);

  // path tables（各套 L/M）
  buildPathTable(PVD_DIR_SECTOR, false).copy(image, PVD_L_PT_SECTOR * SECTOR_SIZE);
  buildPathTable(PVD_DIR_SECTOR, true).copy(image, PVD_M_PT_SECTOR * SECTOR_SIZE);
  buildPathTable(SVD_DIR_SECTOR, false).copy(image, SVD_L_PT_SECTOR * SECTOR_SIZE);
  buildPathTable(SVD_DIR_SECTOR, true).copy(image, SVD_M_PT_SECTOR * SECTOR_SIZE);

  // 目录数据 + 文件内容
  pvdDir.data.copy(image, PVD_DIR_SECTOR * SECTOR_SIZE);
  svdDir.data.copy(image, SVD_DIR_SECTOR * SECTOR_SIZE);
  for (const { file, extent } of placements) {
    file.content.copy(image, extent * SECTOR_SIZE);
  }

  return image;
}

// ---------------------------------------------------------------------------
// 解析（自洽性校验 + 测试抓手）：读出 Joliet 树的文件清单
// ---------------------------------------------------------------------------

/**
 * 从镜像里找到 Joliet SVD，沿其根目录记录读出真实文件名列表（剥掉 ";1"
 * 版本号，跳过 . / .. ）。找不到 SVD 抛错——调用方视为镜像损坏。
 */
export function parseIso9660Files(buf: Buffer): string[] {
  let svdOffset = -1;
  const maxSector = Math.min(Math.floor(buf.length / SECTOR_SIZE), 64);
  for (let sector = PVD_SECTOR; sector < maxSector; sector++) {
    const offset = sector * SECTOR_SIZE;
    if (buf.toString('ascii', offset + 1, offset + 6) !== 'CD001') continue;
    if (buf[offset] === 2) {
      svdOffset = offset;
      break;
    }
  }
  if (svdOffset < 0) {
    throw new Error('镜像里找不到 Joliet 补充卷描述符（SVD）');
  }

  // SVD 根目录记录嵌在描述符 156 偏移处
  const rootExtent = buf.readUInt32LE(svdOffset + 156 + 2);
  const rootSize = buf.readUInt32LE(svdOffset + 156 + 10);
  const dirStart = rootExtent * SECTOR_SIZE;
  const dirEnd = dirStart + rootSize;

  const names: string[] = [];
  let cursor = dirStart;
  while (cursor < dirEnd) {
    const length = buf[cursor];
    if (length === 0) {
      // 本 sector 余量为零填充 → 跳到下一 sector 边界
      cursor = (Math.floor(cursor / SECTOR_SIZE) + 1) * SECTOR_SIZE;
      continue;
    }
    const fileIdLength = buf[cursor + 32];
    const fileId = buf.subarray(cursor + 33, cursor + 33 + fileIdLength);
    const isDot = fileIdLength === 1 && (fileId[0] === 0x00 || fileId[0] === 0x01);
    if (!isDot) {
      names.push(decodeUcs2Be(fileId).replace(/;1$/, ''));
    }
    cursor += length;
  }
  return names;
}

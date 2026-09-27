/**
 * 兼容壳（最小拆 zhishi-memory-core 抽包）：实现已迁至
 * packages/zhishi-memory-core/src/store.ts。本文件：
 *   1. re-export 全部公共面，保持既有 `server/memory/store` 引用路径零改动；
 *   2. 在模块加载时注册两个宿主端口（sqlite 打包路径探测 / expert_refs
 *      查证）——u-disk 的生产语义（sqlite-runtime 布局 + 假引用拒收）由此
 *      恢复；包缺省形态则是裸 better-sqlite3 + 不查证。
 */
import { findMissingExpertEntryIds } from '../expert/store';
import { getBundledSqliteEntryPoint } from '../utils/runtime';
import { setExpertRefValidator, setSqliteEntryPointResolver } from 'zhishi-memory-core/store';

setSqliteEntryPointResolver(() => getBundledSqliteEntryPoint());
setExpertRefValidator(findMissingExpertEntryIds);

export * from 'zhishi-memory-core/store';

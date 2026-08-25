/**
 * 输入历史纯函数单测（1.3.5）：模糊评分（TUI 移植口径）/ 排序截断 /
 * per-env 落盘读写。
 */

import { describe, expect, it } from 'vitest';

import {
  INPUT_HISTORY_LIMIT,
  inputHistoryKey,
  loadInputHistory,
  prependHistory,
  rankInputHistory,
  saveInputHistory,
  scoreHistory,
} from './input-history';

describe('scoreHistory（子序列模糊评分，TUI history.ts:72-90 移植）', () => {
  it('空查询恒为 1（全部命中）', () => {
    expect(scoreHistory('', 'anything')).toBe(1);
  });

  it('全串连续命中得分最高；子序列命中 > 0', () => {
    expect(scoreHistory('history', 'history')).toBeGreaterThan(0);
    expect(scoreHistory('hst', 'history')).toBeGreaterThan(0);
  });

  it('不匹配（字符缺失）→ 0', () => {
    expect(scoreHistory('xyz', 'history')).toBe(0);
    expect(scoreHistory('hz', 'history')).toBe(0); // 'z' 不在候选里
  });

  it('不区分大小写', () => {
    expect(scoreHistory('HIS', 'history')).toBeGreaterThan(0);
    expect(scoreHistory('his', 'HISTORY')).toBeGreaterThan(0);
  });

  it('词首命中得分更高（空白/:/@/- 分隔处加成）', () => {
    // 'ec' 在 'echo' 前缀命中（+3），'spec' 里 'e' 居中无词首加成
    expect(scoreHistory('ec', 'echo')).toBeGreaterThan(scoreHistory('ec', 'spec'));
    // 'ch' 在 'env-check' 里 '-' 分隔处命中（词首 +3）比 'schedule' 居中命中高
    expect(scoreHistory('ch', 'env-check')).toBeGreaterThan(scoreHistory('ch', 'schedule'));
  });

  it('连续命中比分散命中得分高', () => {
    const contiguous = scoreHistory('ab', 'abxx');
    const scattered = scoreHistory('ab', 'axxb');
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it('前缀命中带加成（i===0 词首）', () => {
    const prefix = scoreHistory('hi', 'history');
    const inner = scoreHistory('hi', 'schism');
    expect(prefix).toBeGreaterThan(inner);
  });
});

describe('rankInputHistory（评分排序 + 截断）', () => {
  const list = ['run env check', 'env-check', 'checkout', 'history panel', 'env init script'];

  it('空查询保持最近优先顺序并截断', () => {
    expect(rankInputHistory(list, '', 3)).toEqual(['run env check', 'env-check', 'checkout']);
    expect(rankInputHistory(list, '   ', 2)).toEqual(['run env check', 'env-check']);
  });

  it('按评分降序：词首/连续命中靠前（跨原列表顺序）', () => {
    const out = rankInputHistory(['xxenv', 'env-check', 'plain text'], 'env', 5);
    // 'env-check'（前缀命中 12）> 'xxenv'（居中连续 5）；'plain text' 不匹配被滤掉
    expect(out).toEqual(['env-check', 'xxenv']);
  });

  it('无匹配 → 空数组', () => {
    expect(rankInputHistory(list, 'zzz', 5)).toEqual([]);
  });

  it('同分稳定排序（最近优先）', () => {
    expect(rankInputHistory(['aaa bbb', 'bbb aaa'], 'aaa', 2)).toEqual(['aaa bbb', 'bbb aaa']);
  });

  it('limit 截断', () => {
    expect(rankInputHistory(list, 'env', 1)).toHaveLength(1);
  });
});

describe('落盘（per-env 键 + 注入 storage）', () => {
  function memStorage(seed: Record<string, string> = {}) {
    const data = new Map(Object.entries(seed));
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  }

  it('inputHistoryKey：per-env 键（host 线用 host 键）', () => {
    expect(inputHistoryKey('pwn@docker')).toBe('zhishi.gui.inputHistory.pwn@docker');
    expect(inputHistoryKey('host')).toBe('zhishi.gui.inputHistory.host');
  });

  it('save/load 往返', () => {
    const st = memStorage();
    saveInputHistory(st, 'pwn@docker', ['a', 'b']);
    expect(loadInputHistory(st, 'pwn@docker')).toEqual(['a', 'b']);
    expect(st.data.get('zhishi.gui.inputHistory.pwn@docker')).toBe('["a","b"]');
  });

  it('缺失键 / 非法 JSON / 非数组 / 非字符串条目 → 空数组', () => {
    expect(loadInputHistory(memStorage(), 'none')).toEqual([]);
    expect(loadInputHistory(memStorage({ 'zhishi.gui.inputHistory.x': '{oops' }), 'x')).toEqual([]);
    expect(loadInputHistory(memStorage({ 'zhishi.gui.inputHistory.x': '{"a":1}' }), 'x')).toEqual([]);
    expect(
      loadInputHistory(memStorage({ 'zhishi.gui.inputHistory.x': '["a",2,null,""]' }), 'x'),
    ).toEqual(['a']);
  });

  it('存储异常静默回落', () => {
    expect(
      loadInputHistory({
        getItem: () => {
          throw new Error('denied');
        },
      }, 'x'),
    ).toEqual([]);
    expect(() =>
      saveInputHistory(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error('denied');
          },
        },
        'x',
        ['a'],
      ),
    ).not.toThrow();
  });

  it('storage 缺省（null/undefined）安全', () => {
    expect(loadInputHistory(null, 'x')).toEqual([]);
    expect(loadInputHistory(undefined, 'x')).toEqual([]);
    expect(() => saveInputHistory(undefined, 'x', ['a'])).not.toThrow();
  });
});

describe('prependHistory（前插 + 截断）', () => {
  it('前插并截断到上限', () => {
    const list = Array.from({ length: INPUT_HISTORY_LIMIT }, (_, i) => `m${i}`);
    const out = prependHistory(list, 'new', INPUT_HISTORY_LIMIT);
    expect(out).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(out[0]).toBe('new');
    expect(out[INPUT_HISTORY_LIMIT - 1]).toBe(`m${INPUT_HISTORY_LIMIT - 2}`);
  });

  it('空/纯空白文本不入库（trim 后为空，与 TUI append 同口径）', () => {
    expect(prependHistory(['a'], '', 10)).toEqual(['a']);
    expect(prependHistory(['a'], '   ', 10)).toEqual(['a']);
    expect(prependHistory([' a '], ' b ', 10)).toEqual(['b', ' a ']);
  });

  it('不改变原数组', () => {
    const list = ['a'];
    prependHistory(list, 'b', 10);
    expect(list).toEqual(['a']);
  });
});

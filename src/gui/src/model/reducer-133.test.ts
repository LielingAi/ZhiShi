import { describe, expect, it } from 'vitest';

import { emptySession, type SessionState } from './blocks';
import { reduceSseEvent } from './reducer';

/** chat:system-init → tools 提取（1.3.3 @ 补全数据源）。 */
function run(payload: unknown, session: SessionState = emptySession()) {
  return reduceSseEvent(session, { event: 'chat:system-init', payload });
}

describe('chat:system-init tools 提取（1.3.3）', () => {
  it('info.tools 字符串数组透传为 ReduceResult.tools', () => {
    const res = run({
      info: { model: 'gpt-5', tools: ['env_exec', 'research_log', 'request_decision'] },
    });
    expect(res.session.model).toBe('gpt-5');
    expect(res.tools).toEqual(['env_exec', 'research_log', 'request_decision']);
  });

  it('tools 字段缺失 → 不设置 tools（undefined）', () => {
    const res = run({ info: { model: 'gpt-5' } });
    expect(res.tools).toBeUndefined();
    expect(res.session.model).toBe('gpt-5');
  });

  it('tools 非数组/含非字符串 → 过滤', () => {
    const res = run({ info: { tools: ['a', 42, null, 'b'] } });
    expect(res.tools).toEqual(['a', 'b']);
  });

  it('无 info 也不炸（session 原样返回）', () => {
    const res = run(null);
    expect(res.tools).toBeUndefined();
  });
});

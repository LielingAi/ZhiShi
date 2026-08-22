/**
 * 1.2.6 批次 C 上下文清扫包 — system-prompt / system-prompt-cli-tools unit tests。
 *
 * 覆盖：L1 身份段（pi 引擎名 + 无宿主 shell 的日期纪律）、L2 信道段按场景
 * 分述（cron headless 不再称「桌面客户端对话」）、蒸馏记忆段的记忆检索归属
 * 人侧、cron 教学对齐真实自退机制（[CRON_TASK_COMPLETE] 标记）、
 * buildCliToolsAppend 的 hostShell 门控（无 shell 通道只出不依赖 shell 的段）。
 */
import { describe, expect, it } from 'vitest';

import { buildSystemPromptAppend } from './system-prompt';
import { buildCliToolsAppend } from './system-prompt-cli-tools';

const CRON_SCENARIO = { type: 'cron', taskId: 't1', intervalMinutes: 30, aiCanExit: true } as const;

describe('L1 身份段（1.2.6 清扫）', () => {
  it('内置引擎称「研究引擎（pi）」，不再称 Claude 智能体 SDK', () => {
    const prompt = buildSystemPromptAppend({ type: 'desktop' });
    expect(prompt).toContain('ZhiShi 内置研究引擎（pi）');
    expect(prompt).not.toContain('Claude 智能体 SDK');
  });

  it('日期纪律不教用 Bash 执行 date（pi 工具集无 Bash）', () => {
    const prompt = buildSystemPromptAppend({ type: 'desktop' });
    expect(prompt).not.toContain('用 Bash 执行');
    // 可达形态：锚定环境后经 env_exec 取环境内时间
    expect(prompt).toContain('env_exec');
  });
});

describe('L2 信道段按场景分述（1.2.6）', () => {
  it('cron 场景是 headless 信道，不再称「桌面客户端与你对话」', () => {
    const prompt = buildSystemPromptAppend(CRON_SCENARIO);
    expect(prompt).not.toContain('桌面客户端与你对话');
    expect(prompt).toContain('定时任务触发');
  });

  it('desktop / security 场景各走各的信道文案', () => {
    expect(buildSystemPromptAppend({ type: 'desktop' })).toContain('桌面客户端与你对话');
    expect(buildSystemPromptAppend({ type: 'security' })).toContain('研究终端');
  });
});

describe('cron 自退教学对齐真实机制（1.2.6 B9 关联）', () => {
  it('TMPL_CRON_TASK 教 [CRON_TASK_COMPLETE] 标记，不提不存在的 zhishi cron exit', () => {
    const prompt = buildSystemPromptAppend(CRON_SCENARIO);
    expect(prompt).toContain('[CRON_TASK_COMPLETE');
    expect(prompt).not.toContain('zhishi cron exit');
  });
});

describe('蒸馏记忆段：记忆检索归人侧（1.2.6，宿主无 shell 可达性）', () => {
  it('不教 agent 自己跑 zhishi memory search，标明检索通道在宿主侧由人执行', () => {
    const prompt = buildSystemPromptAppend({ type: 'desktop' }, {
      distilledMemory: {
        userModel: '搭档偏好简洁',
        selfModel: '',
        routines: '',
        reminders: '',
      },
    });
    expect(prompt).toContain('<zhishi-distilled-memory>');
    expect(prompt).toContain('宿主侧');
    expect(prompt).not.toContain('运行「zhishi memory search');
  });
});

describe('buildCliToolsAppend — hostShell 门控（1.2.6）', () => {
  it('hostShell=false + cron(aiCanExit)：只出 task-exit 标记段', () => {
    const out = buildCliToolsAppend(CRON_SCENARIO, { hostShell: false });
    expect(out).toContain('[CRON_TASK_COMPLETE');
    // 依赖宿主 shell 的段一律不注入
    expect(out).not.toContain('zhishi task create-direct');
    expect(out).not.toContain('zhishi memory search');
    expect(out).not.toContain('zhishi term open');
  });

  it('hostShell=false + 非 cron 场景：零注入（没有可达段可教）', () => {
    expect(buildCliToolsAppend({ type: 'desktop' }, { hostShell: false })).toBe('');
    expect(buildCliToolsAppend({ type: 'cron', taskId: 't', intervalMinutes: 5, aiCanExit: false }, { hostShell: false })).toBe('');
  });

  it('默认 hostShell=true（向后兼容外部 runtime 形态）：全段注入', () => {
    const out = buildCliToolsAppend({ type: 'desktop' });
    expect(out).toContain('zhishi task create-direct');
    expect(out).toContain('zhishi memory search');
    expect(out).toContain('zhishi term open');
  });

  it('buildSystemPromptAppend 接线：cliToolsEnabled + cliHostShell=false 的 cron 场景注入自退段', () => {
    const prompt = buildSystemPromptAppend(CRON_SCENARIO, {
      cliToolsEnabled: true,
      cliHostShell: false,
    });
    expect(prompt).toContain('<zhishi-cli-task-exit>');
    expect(prompt).not.toContain('<zhishi-cli-task-schedule>');
    expect(prompt).not.toContain('<zhishi-cli-memory>');
  });

  it('cliToolsEnabled 不传 → CLI 附录零注入（现状语义保持）', () => {
    const prompt = buildSystemPromptAppend(CRON_SCENARIO);
    expect(prompt).not.toContain('<zhishi-cli-task-exit>');
  });
});

import { describe, expect, it } from 'vitest';

import {
  buildSshEnvId,
  buildWizardPayload,
  defaultParamsForSource,
  domainForRecipe,
  findRunningEnvForRecipe,
  initialWizardParams,
  initialWizardState,
  recipeLifecycleNote,
  recipesForSource,
  wizardBack,
  wizardDiscoveredItems,
  wizardNext,
  wizardSelectSource,
  wizardStepError,
  wizardSummaryRows,
  WIZARD_SOURCE_CARDS,
  type EnvWizardState,
} from './env-wizard';
import type { Recipe } from '../client/api';

const RECIPES: Recipe[] = [
  { id: 'pentest', name: '渗透测试', base: 'docker', tools: ['nmap', 'sqlmap'] },
  { id: 'pwn-vm', name: 'PWN 虚拟机', base: 'vm', tools: ['gdb', 'pwntools'], vmUser: 'root' },
  { id: 'rev', name: '逆向', tools: ['ghidra'] },
];

const DOMAINS = [
  { kind: 'pentest', name: '渗透测试域', recipes: ['pentest'] },
  { kind: 'binary', name: '二进制域', recipes: ['pwn-vm', 'rev'] },
];

function stateAt(step: EnvWizardState['step'], patch: Partial<EnvWizardState> = {}): EnvWizardState {
  return { ...initialWizardState(), step, ...patch };
}

describe('向导状态机', () => {
  it('四张来源卡齐备且顺序固定', () => {
    expect(WIZARD_SOURCE_CARDS.map((c) => c.source)).toEqual([
      'docker-recipe',
      'vm-recipe',
      'discovered',
      'ssh',
    ]);
  });

  it('初始在 step 1，未选来源不能前进', () => {
    const s = initialWizardState();
    expect(s.step).toBe(1);
    expect(wizardStepError(s)).toBe('请选择来源类型');
    expect(wizardNext(s)).toEqual(s);
  });

  it('选来源即进 step 2 并预填默认参数（VM 配方带 vmUser）', () => {
    const s = wizardSelectSource(initialWizardState(), 'vm-recipe', RECIPES);
    expect(s.step).toBe(2);
    expect(s.source).toBe('vm-recipe');
    expect(s.params.recipeId).toBe('pwn-vm');
    expect(s.params.vmUser).toBe('root');
  });

  it('recipesForSource 按 base 过滤（缺省 base 归 docker）', () => {
    expect(recipesForSource('docker-recipe', RECIPES).map((r) => r.id)).toEqual(['pentest', 'rev']);
    expect(recipesForSource('vm-recipe', RECIPES).map((r) => r.id)).toEqual(['pwn-vm']);
  });

  it('defaultParamsForSource 空列表不炸', () => {
    expect(defaultParamsForSource('docker-recipe', [])).toEqual({ recipeId: '', vmUser: '' });
    expect(defaultParamsForSource('discovered', RECIPES)).toEqual({});
  });

  it('step 2 各来源必填校验', () => {
    const base = stateAt(2, { source: 'docker-recipe' });
    expect(wizardStepError(base)).toBe('请选择一个配方');
    expect(wizardStepError(stateAt(2, { source: 'discovered' }))).toBe('请勾选一个本机条目');
    expect(wizardStepError(stateAt(2, { source: 'ssh' }))).toBe('host / 用户 / 密钥路径 必填');
    const sshOk = stateAt(2, {
      source: 'ssh',
      params: { ...initialWizardParams(), sshHost: 'h', sshUser: 'u', sshKeyPath: 'k' },
    });
    expect(wizardStepError(sshOk)).toBeNull();
    expect(
      wizardStepError(stateAt(2, { source: 'ssh', params: { ...sshOk.params, sshPort: 'abc' } })),
    ).toBe('端口必须是 1-65535 的整数');
    expect(
      wizardStepError(stateAt(2, { source: 'ssh', params: { ...sshOk.params, sshPort: '70000' } })),
    ).toBe('端口必须是 1-65535 的整数');
  });

  it('前进到 step 4 封顶，回退到 step 1 封底', () => {
    let s = wizardSelectSource(initialWizardState(), 'docker-recipe', RECIPES);
    s = wizardNext(s);
    expect(s.step).toBe(3);
    s = wizardNext(s);
    expect(s.step).toBe(4);
    s = wizardNext(s);
    expect(s.step).toBe(4);
    s = wizardBack(wizardBack(wizardBack(s)));
    expect(s.step).toBe(1);
  });
});

describe('payload 构造', () => {
  it('docker 配方 → up（只带 recipe）', () => {
    const s = stateAt(4, {
      source: 'docker-recipe',
      params: { ...initialWizardParams(), recipeId: 'pentest' },
    });
    expect(buildWizardPayload(s)).toEqual({ type: 'up', input: { recipe: 'pentest' } });
  });

  it('VM 配方 → up（带 user/keyPath）', () => {
    const s = stateAt(4, {
      source: 'vm-recipe',
      params: { ...initialWizardParams(), recipeId: 'pwn-vm', vmUser: ' root ', vmKeyPath: '~/.ssh/id' },
    });
    expect(buildWizardPayload(s)).toEqual({
      type: 'up',
      input: { recipe: 'pwn-vm', user: 'root', keyPath: '~/.ssh/id' },
    });
  });

  it('本机已有 → register（复用 registerDiscovered 的 itemKey）', () => {
    const s = stateAt(4, {
      source: 'discovered',
      params: { ...initialWizardParams(), discoveredKey: 'vmware-/vms/a.vmx' },
    });
    expect(buildWizardPayload(s)).toEqual({ type: 'register', itemKey: 'vmware-/vms/a.vmx' });
  });

  it('本机已有可带附加登记字段（user/keyPath/recipeIds，空则不带 extras；1.5.10 多配方）', () => {
    const s = stateAt(4, {
      source: 'discovered',
      params: {
        ...initialWizardParams(),
        discoveredKey: 'k',
        discoveredUser: ' root ',
        discoveredKeyPath: '~/.ssh/id',
        discoveredRecipeIds: ['pentest'],
      },
    });
    expect(buildWizardPayload(s)).toEqual({
      type: 'register',
      itemKey: 'k',
      extras: { user: 'root', keyPath: '~/.ssh/id', recipeIds: ['pentest'] },
    });
  });

  it('1.3.7 实机修复 B：本机已有 extras 补 address（trim；空串不下发）', () => {
    const s = stateAt(4, {
      source: 'discovered',
      params: {
        ...initialWizardParams(),
        discoveredKey: 'k',
        discoveredAddress: ' 192.168.56.20 ',
        discoveredUser: 'root',
      },
    });
    expect(buildWizardPayload(s)).toEqual({
      type: 'register',
      itemKey: 'k',
      extras: { address: '192.168.56.20', user: 'root' },
    });
  });

  it('1.3.7 实机修复 B：确认页展示 guest 地址行', () => {
    const s = stateAt(3, {
      source: 'discovered',
      params: { ...initialWizardParams(), discoveredKey: 'k', discoveredAddress: '10.0.0.9' },
    });
    const map = Object.fromEntries(
      wizardSummaryRows(s, { recipes: RECIPES, domains: DOMAINS }).map((r) => [r.label, r.value]),
    );
    expect(map['guest 地址']).toBe('10.0.0.9');
  });

  it('SSH → ssh-add：补 port/name/osFamily/recipeIds，空值不下发（1.5.10 多配方）', () => {
    const s = stateAt(4, {
      source: 'ssh',
      params: {
        ...initialWizardParams(),
        sshHost: '10.0.0.8',
        sshUser: 'root',
        sshKeyPath: '~/.ssh/id_ed25519',
        sshPort: '2222',
        sshName: '跳板机',
        sshOsFamily: 'linux',
        sshRecipeIds: ['pentest'],
      },
    });
    expect(buildWizardPayload(s)).toEqual({
      type: 'ssh-add',
      input: {
        id: 'ssh-root-10.0.0.8',
        kind: 'ssh',
        host: '10.0.0.8',
        user: 'root',
        keyPath: '~/.ssh/id_ed25519',
        port: 2222,
        name: '跳板机',
        osFamily: 'linux',
        recipeIds: ['pentest'],
      },
    });
  });

  it('SSH 最小集：port 缺省不下发，id 净化到 registry 闭集', () => {
    const s = stateAt(4, {
      source: 'ssh',
      params: { ...initialWizardParams(), sshHost: 'jump.example.com', sshUser: 'ops', sshKeyPath: 'k' },
    });
    const p = buildWizardPayload(s);
    expect(p?.type).toBe('ssh-add');
    if (p?.type === 'ssh-add') {
      expect(p.input.id).toBe('ssh-ops-jump.example.com');
      expect(p.input).not.toHaveProperty('port');
      expect(p.input).not.toHaveProperty('name');
      expect(p.input).not.toHaveProperty('osFamily');
      expect(p.input).not.toHaveProperty('recipeId');
    }
  });

  it('buildSshEnvId：非法字符净化 + 字母数字开头 + ≤64', () => {
    expect(buildSshEnvId('192.168.1.100', 'root')).toBe('ssh-root-192.168.1.100');
    expect(buildSshEnvId('Host Name!!', 'Ad min')).toBe('ssh-ad-min-host-name');
    expect(buildSshEnvId('!!!', '!!!')).toBe('ssh-env');
    const long = buildSshEnvId('a'.repeat(80), 'u');
    expect(long.length).toBeLessThanOrEqual(64);
    expect(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(long)).toBe(true);
  });

  it('缺必填 → null（step1 / 无配方 / 无勾选 / ssh 缺字段）', () => {
    expect(buildWizardPayload(initialWizardState())).toBeNull();
    expect(buildWizardPayload(stateAt(4, { source: 'docker-recipe' }))).toBeNull();
    expect(buildWizardPayload(stateAt(4, { source: 'discovered' }))).toBeNull();
    expect(buildWizardPayload(stateAt(4, { source: 'ssh' }))).toBeNull();
  });
});

describe('域映射与确认页', () => {
  it('domainForRecipe：recipes 命中即归属，否则 null', () => {
    expect(domainForRecipe('pentest', DOMAINS)?.kind).toBe('pentest');
    expect(domainForRecipe('rev', DOMAINS)?.name).toBe('二进制域');
    expect(domainForRecipe('nope', DOMAINS)).toBeNull();
    expect(domainForRecipe('', DOMAINS)).toBeNull();
  });

  it('配方来源确认页：基底/配方/工具清单/域绑定', () => {
    const s = stateAt(3, {
      source: 'docker-recipe',
      params: { ...initialWizardParams(), recipeId: 'pentest' },
    });
    const rows = wizardSummaryRows(s, { recipes: RECIPES, domains: DOMAINS });
    const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(map['基底']).toBe('docker');
    expect(map['配方']).toBe('pentest');
    expect(map['工具清单']).toBe('nmap · sqlmap');
    expect(map['域绑定']).toBe('渗透测试域（pentest）');
  });

  it('未命中域显示「未绑定」；ssh 未选配方也未绑定', () => {
    const s = stateAt(3, {
      source: 'ssh',
      params: { ...initialWizardParams(), sshHost: 'h', sshUser: 'u', sshKeyPath: 'k' },
    });
    const rows = wizardSummaryRows(s, { recipes: RECIPES, domains: DOMAINS });
    const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(map['域绑定']).toBe('未绑定');
    expect(map['主机']).toBe('u@h');
  });

  it('ssh 选配方 → 确认页显示绑定配方与域；带端口拼进主机行', () => {
    const s = stateAt(3, {
      source: 'ssh',
      params: {
        ...initialWizardParams(),
        sshHost: 'h',
        sshUser: 'u',
        sshKeyPath: 'k',
        sshPort: '2222',
        sshRecipeIds: ['pwn-vm'],
      },
    });
    const map = Object.fromEntries(
      wizardSummaryRows(s, { recipes: RECIPES, domains: DOMAINS }).map((r) => [r.label, r.value]),
    );
    expect(map['主机']).toBe('u@h:2222');
    expect(map['绑定配方']).toBe('pwn-vm');
    expect(map['域绑定']).toBe('二进制域（binary）');
  });
});

describe('boot 完成后自动切换目标', () => {
  const envs = [
    { id: 'pentest', kind: 'docker' as const, recipeId: 'pentest' },
    { id: 'pwn-vm', kind: 'vm' as const, recipeId: 'pwn-vm' },
  ];
  it('仅当实例运行中才返回切换目标', () => {
    expect(findRunningEnvForRecipe('pentest', envs, [{ id: 'pentest' }])).toBe('pentest');
    expect(findRunningEnvForRecipe('pentest', envs, [])).toBeNull();
    expect(findRunningEnvForRecipe('pwn-vm', envs, [{ id: 'pwn-vm' }])).toBe('pwn-vm');
  });
  it('运行中但无登记条目时按 recipeId 直切；空 recipeId → null', () => {
    expect(findRunningEnvForRecipe('x', [], [{ id: 'x' }])).toBe('x');
    expect(findRunningEnvForRecipe('', envs, [{ id: 'pentest' }])).toBeNull();
  });
});


// ===== 1.3.7 场景 3：确认页展示推导能力集合（已有环境） =====

describe('wizardSummaryRows — 能力集合行（1.3.7 场景 3）', () => {
  it('新环境（配方来源）：展示配方工具清单（静态），不出推导集合行', () => {
    const s = stateAt(3, {
      source: 'docker-recipe',
      params: { ...initialWizardParams(), recipeId: 'pentest' },
    });
    const rows = wizardSummaryRows(s, { recipes: RECIPES, domains: DOMAINS, envs: [] });
    const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(map['工具清单']).toBe('nmap · sqlmap');
    expect(map['能力集合（推导）']).toBeUndefined();
  });

  it('已有环境（ssh 命中已登记条目）：展示推导能力集合 + 探测时间', () => {
    const s = stateAt(3, {
      source: 'ssh',
      params: { ...initialWizardParams(), sshHost: 'h', sshUser: 'u', sshKeyPath: 'k' },
    });
    const envs = [
      { id: buildSshEnvId('h', 'u'), capabilityDomains: ['binary', 'pentest'], capabilityDerivedAt: '2026-08-25T12:00:00Z' },
    ];
    const map = Object.fromEntries(
      wizardSummaryRows(s, { recipes: RECIPES, domains: DOMAINS, envs }).map((r) => [r.label, r.value]),
    );
    expect(map['能力集合（推导）']).toBe('binary · pentest（探测于 2026-08-25T12:00:00Z）');
  });

  it('已有环境（本机已有条目按 container 命中）：展示推导能力集合', () => {
    const s = stateAt(3, {
      source: 'discovered',
      params: { ...initialWizardParams(), discoveredKey: 'zhishi-pwn-a3f2' },
    });
    const envs = [{ id: 'pwn-box', container: 'zhishi-pwn-a3f2', capabilityDomains: ['binary'] }];
    const map = Object.fromEntries(
      wizardSummaryRows(s, { recipes: RECIPES, domains: DOMAINS, envs }).map((r) => [r.label, r.value]),
    );
    expect(map['能力集合（推导）']).toBe('binary');
  });

  it('未登记/未推导（无 envs 或条目无 capabilityDomains）→ 不出能力集合行', () => {
    const s = stateAt(3, {
      source: 'discovered',
      params: { ...initialWizardParams(), discoveredKey: 'zhishi-pwn-a3f2' },
    });
    for (const ctx of [
      { recipes: RECIPES, domains: DOMAINS },
      { recipes: RECIPES, domains: DOMAINS, envs: [] },
      { recipes: RECIPES, domains: DOMAINS, envs: [{ id: 'pwn-box', container: 'zhishi-pwn-a3f2' }] },
    ]) {
      const labels = wizardSummaryRows(s, ctx).map((r) => r.label);
      expect(labels).not.toContain('能力集合（推导）');
    }
  });
});


// ===== 1.3.7 实机修复 A/B：「本机已有」步骤条目视图模型 =====

describe('wizardDiscoveredItems（1.3.7 实机修复）', () => {
  const ENVS = [
    { id: 'fuzz', kind: 'vm', name: 'fuzz', vmName: 'fuzz', vmx: 'E:\\VMs\\fuzz\\vmware-fuzz.vmx' },
    { id: 'docker-kali', kind: 'docker', container: 'kali-2024' },
  ];

  it('1.5.10（B 拍板）：容器不可认领——docker 入参不产行，VM 条目标 isVm（补收 address/user/keyPath 用）', () => {
    const items = wizardDiscoveredItems(
      [{ id: 'c1', name: 'alpine', status: 'Up 2 hours' }],
      [{ id: 'v1', name: 'win11', driver: 'hyperv', state: 'Running' }],
      [],
    );
    // docker 容器不进列表（zhishi 容器经 up 回写登记；容器缺 /workspace 挂载层）
    expect(items.map((i) => [i.key, i.isVm])).toEqual([['v1', true]]);
    expect(items[0].detail).toBe('hyperv · Running');
    expect(items.every((i) => i.registeredAs === undefined)).toBe(true);
  });

  it('同族命中已登记 → registeredAs 标注（勾选禁用），detail 带「已登记为 X」（VM 面）', () => {
    const items = wizardDiscoveredItems(
      [],
      [{ id: 'v2', name: 'vmware-fuzz.vmx', driver: 'vmware', state: 'unknown', vmx: 'e:/vms/fuzz/vmware-fuzz.vmx' }],
      ENVS,
    );
    expect(items).toHaveLength(1);
    expect(items[0].registeredAs).toBe('fuzz');
    expect(items[0].detail).toContain('已登记为 fuzz');
  });
});


// ===== 1.3.8 ③a：向导生命周期差异显性化 =====

describe('recipeLifecycleNote（1.3.8 ③a 生命周期差异）', () => {
  it('vm → 持久可快照；docker/缺省 → 现场持久（1.5.10 镜像为主）', () => {
    expect(recipeLifecycleNote('vm')).toBe('持久虚拟机，可快照回滚');
    expect(recipeLifecycleNote('docker')).toBe('现场持久（停止=暂停，重启续现场）');
    expect(recipeLifecycleNote(undefined)).toBe('现场持久（停止=暂停，重启续现场）');
  });

  it('确认页带「生命周期」行（docker/vm 各一句）', () => {
    const dockerState = stateAt(3, {
      source: 'docker-recipe',
      params: { ...initialWizardParams(), recipeId: 'pentest' },
    });
    const dockerMap = Object.fromEntries(
      wizardSummaryRows(dockerState, { recipes: RECIPES, domains: DOMAINS }).map((r) => [r.label, r.value]),
    );
    expect(dockerMap['基底']).toBe('docker');
    expect(dockerMap['生命周期']).toBe('现场持久（停止=暂停，重启续现场）');

    const vmState = stateAt(3, {
      source: 'vm-recipe',
      params: { ...initialWizardParams(), recipeId: 'pwn-vm' },
    });
    const vmMap = Object.fromEntries(
      wizardSummaryRows(vmState, { recipes: RECIPES, domains: DOMAINS }).map((r) => [r.label, r.value]),
    );
    expect(vmMap['生命周期']).toBe('持久虚拟机，可快照回滚');
  });
});

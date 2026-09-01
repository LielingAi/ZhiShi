/**
 * 环境侧栏分组单测。
 */

import { describe, expect, it } from 'vitest';

import { buildRegisterPayload, capabilityBadgeText, capabilityTooltip, groupSidebar, isDiscoveredRunning, matchRegisteredEnv, psRowMatchesEntry, resolveEnvState } from './envs';

const envs = [
  { id: 'pwn@docker', kind: 'docker', name: 'pwn@docker' },
  { id: 'audit-box', kind: 'docker', name: 'audit-box' },
];
const running = [
  { id: 'pwn@docker', status: 'running', driver: 'docker' },
];
const discovered = [
  { id: 'kali-2024', name: 'kali-2024', state: 'powered off', driver: 'vmware' },
  { id: 'pwn@docker', name: 'pwn@docker', state: 'running', driver: 'docker' }, // 已登记 → 不入本机已有
];

describe('groupSidebar', () => {
  it('三组划分：运行中 / 已停止 / 本机已有（去重已登记）', () => {
    const groups = groupSidebar(envs, running, discovered);
    expect(groups.map((g) => g.label)).toEqual(['运行中', '已停止', '本机已有']);
    expect(groups[0].items.map((i) => i.key)).toEqual(['pwn@docker']);
    expect(groups[1].items.map((i) => i.key)).toEqual(['audit-box']);
    expect(groups[2].items.map((i) => i.key)).toEqual(['kali-2024']);
  });

  it('空组不渲染', () => {
    const groups = groupSidebar([], [], []);
    expect(groups).toEqual([]);
  });

  it('运行中实例用登记名回退', () => {
    const groups = groupSidebar([], [{ id: 'c1', name: '容器一', status: 'running', driver: 'docker' }], []);
    expect(groups[0].items[0].label).toBe('容器一');
  });
});

describe('startable（1.3.1 ① 启动按钮）', () => {
  const base = { id: 's', name: 's' };

  it('docker/vm 带 recipeId → 启动按钮可用', () => {
    const groups = groupSidebar(
      [
        { ...base, kind: 'docker', recipeId: 'pwn' },
        { ...base, id: 'v', kind: 'vm', recipeId: 'rev' },
        { ...base, id: 'x', kind: 'ssh' },
      ],
      [],
      [],
    );
    const stop = groups.find((g) => g.label === '已停止');
    expect(stop).toBeDefined();
    const byKey = new Map(stop!.items.map((i) => [i.key, i]));
    expect(byKey.get('s')?.startable).toBe(true);
    expect(byKey.get('s')?.recipeId).toBe('pwn');
    expect(byKey.get('v')?.startable).toBe(true);
    expect(byKey.get('x')?.startable).toBe(false); // ssh 无配方不可启
  });

  it('运行中 / 本机已有组永不可启动（已在跑 / 未登记）', () => {
    const groups = groupSidebar(
      [{ ...base, kind: 'docker', recipeId: 'pwn' }],
      [{ id: 's', status: 'running', driver: 'docker' }],
      [{ id: 'k', name: 'k', state: 'powered off', driver: 'vmware' }],
    );
    const run = groups.find((g) => g.label === '运行中');
    const unreg = groups.find((g) => g.label === '本机已有');
    expect(run?.items[0].startable).toBe(false);
    expect(unreg?.items[0].startable).toBe(false);
  });
});

describe('buildRegisterPayload（1.3.5 选中即注册；1.3.7 起 vm id = vmName「实例即环境」）', () => {
  it('docker → docker-<名> { kind:docker, container }', () => {
    expect(
      buildRegisterPayload({ id: 'abc123', name: 'kali-2024', state: 'Up 3 hours', driver: 'docker' }),
    ).toEqual({ id: 'docker-kali-2024', kind: 'docker', container: 'kali-2024' });
  });

  it('vmware → id = vmName = vmx 文件 stem（去 .vmx 后缀）', () => {
    expect(
      buildRegisterPayload({
        id: 'E:\\vms\\kali.vmx',
        name: 'kali.vmx',
        state: 'unknown',
        driver: 'vmware',
        vmx: 'E:\\vms\\kali.vmx',
        osFamily: 'linux',
      }),
    ).toEqual({
      id: 'kali',
      kind: 'vm',
      vmName: 'kali',
      vmx: 'E:\\vms\\kali.vmx',
      name: 'kali',
      osFamily: 'linux',
    });
  });

  it('hyperv / vbox → id = vmName（无 vmx，仅带 name/osFamily）', () => {
    expect(
      buildRegisterPayload({ id: 'win11', name: 'win11', state: 'Running', driver: 'hyperv', osFamily: 'windows' }),
    ).toEqual({ id: 'win11', kind: 'vm', vmName: 'win11', name: 'win11', osFamily: 'windows' });
    expect(buildRegisterPayload({ id: 'kali', name: 'kali', driver: 'vbox' })).toEqual({
      id: 'kali',
      kind: 'vm',
      vmName: 'kali',
      name: 'kali',
    });
  });

  it('VM 名含非法字符 → id 净化（registry ID_PATTERN），vmName 保留原名', () => {
    expect(
      buildRegisterPayload({ id: 'w', name: 'Windows 10 x64', driver: 'hyperv' }),
    ).toEqual({ id: 'Windows-10-x64', kind: 'vm', vmName: 'Windows 10 x64', name: 'Windows 10 x64' });
    // 净化后为空（全是非法字符）→ null
    expect(buildRegisterPayload({ id: 'w', name: '中文虚拟机', driver: 'hyperv' })).toBeNull();
  });

  it('名字缺失 / 未知驱动 → null（调用方 toast）', () => {
    expect(buildRegisterPayload({ id: 'x', name: '', driver: 'docker' })).toBeNull();
    expect(buildRegisterPayload({ id: 'x', name: '  ', driver: 'vmware' })).toBeNull();
    expect(buildRegisterPayload({ id: 'x', name: 'x', driver: 'ssh' })).toBeNull();
    expect(buildRegisterPayload({ id: 'x', driver: 'docker' })).toBeNull();
  });

  it('1.3.7 实机修复 B：extras.address 仅 VM 透传，docker 不带', () => {
    expect(
      buildRegisterPayload(
        { id: 'E:\\vms\\fuzz.vmx', name: 'fuzz.vmx', driver: 'vmware', vmx: 'E:\\vms\\fuzz.vmx' },
        { address: '192.168.56.20', user: 'root', keyPath: '~/.ssh/id_ed25519' },
      ),
    ).toEqual({
      id: 'fuzz',
      kind: 'vm',
      vmName: 'fuzz',
      vmx: 'E:\\vms\\fuzz.vmx',
      name: 'fuzz',
      address: '192.168.56.20',
      user: 'root',
      keyPath: '~/.ssh/id_ed25519',
    });
    // docker 载荷不带 address/user/keyPath（容器通道不需要——1.5.10）
    expect(
      buildRegisterPayload(
        { id: 'c1', name: 'kali', driver: 'docker' },
        { address: '10.0.0.9', user: 'root', keyPath: '~/.ssh/id_ed25519', recipeId: 'pentest' },
      ),
    ).toEqual({ id: 'docker-kali', kind: 'docker', container: 'kali', recipeId: 'pentest' });
    // 空串 address 视同未填（逐字段空值剔除）
    expect(
      buildRegisterPayload({ id: 'v', name: 'kali', driver: 'vbox' }, { address: '' }),
    ).toEqual({ id: 'kali', kind: 'vm', vmName: 'kali', name: 'kali' });
  });
});

// ===== 1.3.7 实机修复 A：本机发现 ↔ 已登记 同族匹配（防重复登记） =====

describe('matchRegisteredEnv（1.3.7 实机修复 A）', () => {
  const ENVS = [
    { id: 'fuzz', kind: 'vm', name: 'fuzz', vmName: 'fuzz', vmx: 'E:\\VMs\\fuzz\\vmware-fuzz.vmx' },
    { id: 'docker-kali', kind: 'docker', container: 'kali-2024' },
  ];

  it('vmx 路径归一化命中（大小写 / 正反斜杠不敏感）', () => {
    const d = { id: 'vmware-e:/vms/fuzz/vmware-fuzz.vmx', name: 'vmware-fuzz.vmx', driver: 'vmware', vmx: 'e:/VMs/fuzz/vmware-fuzz.vmx/' };
    expect(matchRegisteredEnv(d, ENVS)?.id).toBe('fuzz');
  });

  it('vmName 命中（vmware discover 名去 .vmx stem；大小写不敏感）', () => {
    const d = { id: 'x', name: 'Fuzz.vmx', driver: 'vmware' }; // 无 vmx 也能按名命中
    expect(matchRegisteredEnv(d, ENVS)?.id).toBe('fuzz');
    // hyperv/vbox 的 name 即 VM 名
    expect(matchRegisteredEnv({ id: 'y', name: 'fuzz', driver: 'hyperv' }, ENVS)?.id).toBe('fuzz');
  });

  it('docker container 命中（entry.container === discovered.name，精确）', () => {
    expect(matchRegisteredEnv({ id: 'abc123', name: 'kali-2024', driver: 'docker' }, ENVS)?.id).toBe('docker-kali');
  });

  it('无命中 → null（不同 VM / 不同容器 / 未知驱动）', () => {
    expect(matchRegisteredEnv({ id: 'z', name: 'other.vmx', driver: 'vmware', vmx: 'D:\\vms\\other.vmx' }, ENVS)).toBeNull();
    expect(matchRegisteredEnv({ id: 'z', name: 'alpine', driver: 'docker' }, ENVS)).toBeNull();
    expect(matchRegisteredEnv({ id: 'z', name: 'kali-2024', driver: 'unknown' }, ENVS)).toBeNull();
    expect(matchRegisteredEnv({ id: 'z', name: 'x', driver: 'vmware' }, [])).toBeNull();
  });

  it('groupSidebar：同族命中 → 带 registeredAs 徽章（detail 标注已登记为 X）', () => {
    const groups = groupSidebar(
      [{ id: 'fuzz', kind: 'vm', name: 'fuzz', vmName: 'fuzz', vmx: 'E:\\VMs\\fuzz\\vmware-fuzz.vmx' }],
      [],
      [{ id: 'vmware-e:/vms/fuzz/vmware-fuzz.vmx', name: 'vmware-fuzz.vmx', driver: 'vmware', vmx: 'E:\\VMs\\fuzz\\vmware-fuzz.vmx' }],
    );
    const unreg = groups.find((g) => g.label === '本机已有')!;
    expect(unreg.items).toHaveLength(1);
    expect(unreg.items[0].registeredAs).toEqual({ key: 'fuzz', label: 'fuzz' });
    expect(unreg.items[0].detail).toContain('已登记为 fuzz');
  });

  it('groupSidebar：未命中的 discover 条目保持无徽章（可登记）', () => {
    const groups = groupSidebar(
      [{ id: 'fuzz', kind: 'vm', vmName: 'fuzz' }],
      [],
      [{ id: 'x', name: 'kali-2024', state: 'powered off', driver: 'vmware' }],
    );
    const unreg = groups.find((g) => g.label === '本机已有')!;
    expect(unreg.items[0].registeredAs).toBeUndefined();
    expect(unreg.items[0].detail).toContain('未登记');
  });
});

describe('isDiscoveredRunning（1.3.5 登记后是否切入）', () => {
  it('docker Up / VM running → true；停着/unknown → false', () => {
    expect(isDiscoveredRunning({ id: 'd', state: 'Up 3 hours', driver: 'docker' })).toBe(true);
    expect(isDiscoveredRunning({ id: 'd', state: 'Up About a minute', driver: 'docker' })).toBe(true);
    expect(isDiscoveredRunning({ id: 'd', state: 'Exited (0) 2 days ago', driver: 'docker' })).toBe(false);
    expect(isDiscoveredRunning({ id: 'v', state: 'Running', driver: 'hyperv' })).toBe(true);
    expect(isDiscoveredRunning({ id: 'v', state: 'powered off', driver: 'vmware' })).toBe(false);
    expect(isDiscoveredRunning({ id: 'v', state: 'unknown', driver: 'vmware' })).toBe(false);
    expect(isDiscoveredRunning({ id: 'v' })).toBe(false);
  });
});


// ===== 1.3.7 场景 3：能力集合（现场推导）透明展示 =====

describe('能力徽章（1.3.7 场景 3）', () => {
  it('已停止/运行中条目带 capabilityDomains → capability 进侧栏项', () => {
    const groups = groupSidebar(
      [
        { id: 'pwn-box', kind: 'docker', recipeId: 'pwn', capabilityDomains: ['binary', 'pentest'], capabilityDerivedAt: '2026-08-25T12:00:00Z' },
        { id: 'legacy', kind: 'docker' }, // 存量条目无字段 → 无徽章
      ],
      [{ id: 'run-1', status: 'running', driver: 'docker' }],
      [],
    );
    const stop = groups.find((g) => g.label === '已停止')!.items;
    expect(stop.find((i) => i.key === 'pwn-box')?.capability).toEqual({
      domains: ['binary', 'pentest'],
      derivedAt: '2026-08-25T12:00:00Z',
    });
    expect(stop.find((i) => i.key === 'legacy')?.capability).toBeUndefined();
  });

  it('运行中条目经登记条目反查能力集合', () => {
    const groups = groupSidebar(
      [{ id: 'r1', kind: 'docker', capabilityDomains: ['pentest'] }],
      [{ id: 'r1', status: 'running', driver: 'docker' }],
      [],
    );
    expect(groups[0].items[0].capability?.domains).toEqual(['pentest']);
  });

  it('徽章文案与 tooltip（含探测时间）', () => {
    const cap = { domains: ['pentest', 'binary'], derivedAt: '2026-08-25T12:00:00Z' };
    expect(capabilityBadgeText(cap)).toBe('能力：pentest · binary');
    expect(capabilityTooltip(cap)).toContain('能力：pentest · binary');
    expect(capabilityTooltip(cap)).toContain('现场推导');
    expect(capabilityTooltip(cap)).toContain('2026-08-25T12:00:00Z');
  });

  it('空能力集合视同未推导（不出徽章）', () => {
    const groups = groupSidebar([{ id: 'e', kind: 'docker', capabilityDomains: [] }], [], []);
    expect(groups[0].items[0].capability).toBeUndefined();
  });

  it('1.4.9：集合内工具口径进徽章与 tooltip（在场 M/N + 缺失清单 + 缺 N 标记）', () => {
    const groups = groupSidebar(
      [{
        id: 'e1',
        kind: 'vm',
        capabilityDomains: ['binary'],
        capabilityDerivedAt: '2026-08-29T00:00:00Z',
        capabilityTools: { total: 9, missing: ['opengrep', 'joern'] },
      }],
      [],
      [],
    );
    const cap = groups[0].items[0].capability!;
    expect(cap.toolsTotal).toBe(9);
    expect(cap.toolsMissing).toEqual(['opengrep', 'joern']);
    expect(capabilityBadgeText(cap)).toBe('能力：binary · 缺2');
    const tip = capabilityTooltip(cap);
    expect(tip).toContain('工具在场 7/9');
    expect(tip).toContain('opengrep、joern');
    // 无缺失 → 徽章不带缺口标记
    expect(capabilityBadgeText({ domains: ['binary'], toolsTotal: 9, toolsMissing: [] })).toBe('能力：binary');
  });

  it('1.5.7：待装口径进徽章与 tooltip（缺 0 待装 2）', () => {
    const groups = groupSidebar(
      [{
        id: 'e2',
        kind: 'vm',
        capabilityDomains: ['binary'],
        capabilityTools: { total: 9, missing: [], toolsPending: 2 },
        capabilityPending: ['joern', 'zap'],
      }],
      [],
      [],
    );
    const cap = groups[0].items[0].capability!;
    // capabilityOf 透传：capabilityPending → toolsPending
    expect(cap.toolsPending).toEqual(['joern', 'zap']);
    expect(capabilityBadgeText(cap)).toBe('能力：binary · 待装2');
    const tip = capabilityTooltip(cap);
    // 待装不在场也不算缺失：在场 7/9（9 - 0 缺 - 2 待装）
    expect(tip).toContain('工具在场 7/9');
    expect(tip).toContain('待装（2）：joern、zap');
    expect(tip).toContain('首跑自动安装中，稍候或手动刷新');
    // 待装不出「补齐环境」引导（那是 missing 的语义）
    expect(tip).not.toContain('补齐环境');
  });

  it('1.5.7：缺与待装同时出现（缺 1 待装 1）', () => {
    const cap = {
      domains: ['binary'],
      toolsTotal: 9,
      toolsMissing: ['opengrep'],
      toolsPending: ['joern'],
    };
    expect(capabilityBadgeText(cap)).toBe('能力：binary · 缺1 · 待装1');
    const tip = capabilityTooltip(cap);
    expect(tip).toContain('工具在场 7/9');
    expect(tip).toContain('声明了但环境里没有（1）：opengrep——可用「⋯ → 补齐环境」安装');
    expect(tip).toContain('待装（1）：joern——首跑自动安装中，稍候或手动刷新');
  });

  it('1.5.7：无缺无待装 → 徽章与 tooltip 不带缺口/待装标记（全无）', () => {
    const cap = { domains: ['binary'], toolsTotal: 9, toolsMissing: [], toolsPending: [] };
    expect(capabilityBadgeText(cap)).toBe('能力：binary');
    const tip = capabilityTooltip(cap);
    expect(tip).toContain('工具在场 9/9');
    expect(tip).not.toContain('待装');
  });

  it('1.5.7：混合形态（域截断 +N 与缺/待装标记叠加）', () => {
    const cap = {
      domains: ['binary', 'pentest', 'ai-security'],
      toolsTotal: 9,
      toolsMissing: ['opengrep'],
      toolsPending: ['joern', 'zap'],
    };
    expect(capabilityBadgeText(cap)).toBe('能力：binary · pentest +1 · 缺1 · 待装2');
    expect(capabilityTooltip(cap)).toContain('待装（2）：joern、zap');
  });
});


// ===== 1.3.8 ②：三态判定单点（resolveEnvState） =====

describe('resolveEnvState（1.3.8 ② 三态判定唯一事实源）', () => {
  const ENVS = [
    { id: 'fuzz', kind: 'vm', name: 'fuzz', vmName: 'fuzz', vmx: 'E:\\VMs\\fuzz\\vmware-fuzz.vmx', recipeId: 'fuzz' },
    { id: 'docker-kali', kind: 'docker', container: 'kali-2024', recipeId: 'pentest' },
    { id: 'hop', kind: 'ssh' },
  ];

  it('登记条目 + ps 命中 → running（不可启动）', () => {
    const st = resolveEnvState({ entry: ENVS[1] }, [{ id: 'docker-kali', status: 'running' }], ENVS);
    expect(st).toEqual({ state: 'running', startable: false });
  });

  it('登记条目 + ps 未命中 → stopped；docker/vm 带 recipeId 才可启动', () => {
    expect(resolveEnvState({ entry: ENVS[0] }, [], ENVS)).toEqual({ state: 'stopped', startable: true });
    expect(resolveEnvState({ entry: ENVS[1] }, [], ENVS)).toEqual({ state: 'stopped', startable: true });
    // ssh 无配方 → 不可启动
    expect(resolveEnvState({ entry: ENVS[2] }, [], ENVS)).toEqual({ state: 'stopped', startable: false });
    // docker 但 recipeId 空串 → 不可启动
    expect(
      resolveEnvState({ entry: { id: 'd', kind: 'docker', recipeId: '' } }, [], ENVS).startable,
    ).toBe(false);
  });

  it('发现条目 → unregistered；同族命中带 registeredAs，未命中则不带', () => {
    const hit = resolveEnvState(
      { discovered: { id: 'abc', name: 'kali-2024', driver: 'docker', state: 'Exited (0)' } },
      [],
      ENVS,
    );
    expect(hit.state).toBe('unregistered');
    expect(hit.registeredAs).toEqual({ key: 'docker-kali', label: 'docker-kali' });
    expect(hit.localStopped).toBe(true);

    const miss = resolveEnvState(
      { discovered: { id: 'v', name: 'other.vmx', driver: 'vmware', state: 'unknown' } },
      [],
      ENVS,
    );
    expect(miss.state).toBe('unregistered');
    expect(miss.registeredAs).toBeUndefined();
    expect(miss.localStopped).toBe(false);
  });

  it('发现条目停止态判定：exit / powered / saved → localStopped', () => {
    for (const state of ['Exited (1)', 'powered off', 'Saved']) {
      expect(
        resolveEnvState({ discovered: { id: 'x', name: 'x', driver: 'docker', state } }, [], []).localStopped,
      ).toBe(true);
    }
    expect(
      resolveEnvState({ discovered: { id: 'x', name: 'x', driver: 'docker', state: 'Up 2 hours' } }, [], [])
        .localStopped,
    ).toBe(false);
  });

  it('防御：空身份 → unregistered，不炸', () => {
    expect(resolveEnvState({}, [], [])).toEqual({ state: 'unregistered', startable: false });
  });

  it('与 groupSidebar 同口径：stopped/unregistered 行的 startable 与 registeredAs 一致', () => {
    const groups = groupSidebar(ENVS, [], [{ id: 'abc', name: 'kali-2024', driver: 'docker', state: 'Exited (0)' }]);
    const stop = groups.find((g) => g.label === '已停止')!.items;
    const unreg = groups.find((g) => g.label === '本机已有')!.items;
    for (const e of ENVS) {
      const st = resolveEnvState({ entry: e }, [], ENVS);
      const item = stop.find((i) => i.key === e.id)!;
      expect(item.startable).toBe(st.startable);
    }
    expect(unreg[0].registeredAs).toEqual(
      resolveEnvState({ discovered: { id: 'abc', name: 'kali-2024', driver: 'docker', state: 'Exited (0)' } }, [], ENVS)
        .registeredAs,
    );
  });
});


// ===== 1.3.8 B1：docker ps 行 ↔ 登记条目的匹配键统一 =====

describe('psRowMatchesEntry（1.3.8 B1）', () => {
  const entry = { id: 'zhishi-pwn-a3f2', kind: 'docker', container: 'zhishi-pwn-a3f2' };

  it('主键 id 相等即命中（服务端已归一 docker 行 id 为条目 id）', () => {
    expect(psRowMatchesEntry({ id: 'zhishi-pwn-a3f2', driver: 'docker' }, entry)).toBe(true);
  });

  it('兜底：docker 短 id 行按 row.name === entry.container 命中', () => {
    expect(
      psRowMatchesEntry({ id: 'a3f2b1c4d5e6', name: 'zhishi-pwn-a3f2', driver: 'docker' }, entry),
    ).toBe(true);
  });

  it('不误伤：容器名不同不命中；非 docker 条目不走容器名兜底', () => {
    expect(psRowMatchesEntry({ id: 'x', name: 'other', driver: 'docker' }, entry)).toBe(false);
    expect(
      psRowMatchesEntry(
        { id: 'x', name: 'fuzz', driver: 'vm' },
        { id: 'fuzz-env', kind: 'vm', container: 'fuzz' },
      ),
    ).toBe(false);
  });
});

describe('groupSidebar — B1 docker 双身份收敛', () => {
  it('短 id docker 行 ∩ 登记条目 → 只落「运行中」一组，条目不再重复落「已停止」', () => {
    const groups = groupSidebar(
      [{ id: 'zhishi-pwn-a3f2', kind: 'docker', container: 'zhishi-pwn-a3f2', recipeId: 'pwn' }],
      [{ id: 'a3f2b1c4d5e6', name: 'zhishi-pwn-a3f2', status: 'Up 2 hours', driver: 'docker' }],
      [],
    );
    expect(groups.map((g) => g.label)).toEqual(['运行中']);
    // key 归一为条目 id——environment/select 只认登记 id，短 id 会落悬空 selection
    expect(groups[0].items[0].key).toBe('zhishi-pwn-a3f2');
    expect(groups[0].items[0].kind).toBe('docker');
  });

  it('resolveEnvState 同口径：短 id docker 行命中 → 条目状态 running', () => {
    const entry = { id: 'zhishi-pwn-a3f2', kind: 'docker', container: 'zhishi-pwn-a3f2', recipeId: 'pwn' };
    const st = resolveEnvState(
      { entry },
      [{ id: 'a3f2b1c4d5e6', name: 'zhishi-pwn-a3f2', driver: 'docker' }],
      [entry],
    );
    expect(st.state).toBe('running');
  });
});

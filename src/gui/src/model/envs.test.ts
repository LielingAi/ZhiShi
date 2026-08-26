/**
 * 环境侧栏分组单测。
 */

import { describe, expect, it } from 'vitest';

import { buildRegisterPayload, capabilityBadgeText, capabilityTooltip, groupSidebar, isDiscoveredRunning, isSwitchable, matchRegisteredEnv } from './envs';

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

describe('isSwitchable', () => {
  it('unreg 组不可切换（未登记）', () => {
    expect(isSwitchable({ key: 'x', label: 'x', group: 'unreg', detail: '', kind: 'docker', warn: false, startable: false })).toBe(false);
    expect(isSwitchable({ key: 'x', label: 'x', group: 'run', detail: '', kind: 'docker', warn: false, startable: false })).toBe(true);
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
    // docker 载荷不带 address（容器通道不需要）
    expect(
      buildRegisterPayload(
        { id: 'c1', name: 'kali', driver: 'docker' },
        { address: '10.0.0.9', user: 'root' },
      ),
    ).toEqual({ id: 'docker-kali', kind: 'docker', container: 'kali', user: 'root' });
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
});

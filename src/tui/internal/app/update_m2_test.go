package app

import (
	"context"
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
	"github.com/lielingai/zhishi/tui/internal/protocol"
	"github.com/lielingai/zhishi/tui/internal/store"
)

// fakeAdmin 是可编程的管理面打桩：记下调用参数、回放预设结果。
// 四个覆盖层的"加载 → 选中 → 执行"都在它上面验，不碰网络。
type fakeAdmin struct {
	envs    []client.EnvironmentInfo
	envsErr error

	// 切环境：记录收到的 (workspace, id)，回 selectSID。
	selected  [][2]string
	selectErr error
	selectSID string

	sessions    []client.SessionInfo
	sessionsErr error
	switched    []string
	switchErr   error

	tasks    []client.TaskInfo
	tasksErr error

	archive     []client.ArchiveEntity
	archiveErr  error
	archiveSIDs []string

	wire     map[string]client.WirePage // key = loopSessionId
	wireErr  error
	wireSIDs []string

	// P0 写操作
	taskOps        []string
	taskOpErr      error
	models         []client.ModelOption
	modelsErr      error
	chatModels     []string
	chatModelErr   error
	reset          int
	rewinds        []string
	forks          []string
	sessionOpErr   error
	queueCancels   []string
	queueCancelErr error

	autoRun         client.AutoRunInfo
	autoRuns        []client.AutoRunInfo
	autoRunErr      error
	autoRunStops    []string
	autoRunStopErr  error
	autoRunStarts   []string
	autoRunStartErr error

	sessionPatches   []string
	sessionPatchErr  error
	sessionDeletes   []string
	sessionDeleteErr error
	taskGets         []string
	taskDetail       client.TaskDetail
	taskGetErr       error

	reportWorkspaces []string
	reportInfo       client.ReportExportInfo
	reportErr        error
	envOps           []string
	envOpErr         error
	recipes          []client.EnvRecipe
	archiveOps       []string
	archiveOpErr     error
	searchQueries    []string
	memoryHits       []client.MemoryHit
	expertHits       []client.ExpertHit
	intelText        string
	intelCount       int
	searchErr        error
}

func (f *fakeAdmin) Environments(context.Context) ([]client.EnvironmentInfo, error) {
	return f.envs, f.envsErr
}

func (f *fakeAdmin) SelectEnvironment(_ context.Context, workspace, id string) (string, error) {
	f.selected = append(f.selected, [2]string{workspace, id})
	return f.selectSID, f.selectErr
}

func (f *fakeAdmin) Sessions(context.Context) ([]client.SessionInfo, error) {
	return f.sessions, f.sessionsErr
}

func (f *fakeAdmin) SwitchSession(_ context.Context, id string) error {
	f.switched = append(f.switched, id)
	return f.switchErr
}

func (f *fakeAdmin) Tasks(context.Context) ([]client.TaskInfo, error) {
	return f.tasks, f.tasksErr
}

func (f *fakeAdmin) Archive(_ context.Context, sessionID string) ([]client.ArchiveEntity, error) {
	f.archiveSIDs = append(f.archiveSIDs, sessionID)
	return f.archive, f.archiveErr
}

func (f *fakeAdmin) WireMessages(_ context.Context, loopSessionID string) (client.WirePage, error) {
	f.wireSIDs = append(f.wireSIDs, loopSessionID)
	if f.wireErr != nil {
		return client.WirePage{}, f.wireErr
	}
	return f.wire[loopSessionID], nil
}

// adminModel 是带打桩管理面与 workspace 的测试 Model。
func adminModel(fa *fakeAdmin) Model {
	m := testModel()
	m.Admin = fa
	m.Workspace = "/tmp/ws"
	m.SessionID = "ls-1"
	return m
}

// pump 执行一条 Cmd 并把结果喂回归约器（探针的 mini 循环同款）。
func pump(t *testing.T, m Model, cmd tea.Cmd) Model {
	t.Helper()
	if cmd == nil {
		t.Fatal("期望有命令，实际 nil")
	}
	msg := cmd()
	if msg == nil {
		t.Fatal("命令返回了 nil 消息")
	}
	m, _ = m.Update(msg)
	return m
}

// ── 环境面板 ───────────────────────────────────────────────────────────

func TestEnvOverlayOpenLoadSelect(t *testing.T) {
	fa := &fakeAdmin{
		envs: []client.EnvironmentInfo{
			{ID: "local", Kind: "local", Name: "本机"},
			{ID: "kali", Kind: "ssh", Host: "10.0.0.5", User: "root", CapabilityDomains: []string{"pentest"}},
		},
		selectSID: "ls-2",
	}
	m := adminModel(fa)

	m, cmd := m.Update(alt('e'))
	ov, ok := lastOverlayOf[*envOverlay](&m)
	if !ok {
		t.Fatal("Alt+e 应压入环境面板")
	}
	if ov.state != loadRunning {
		t.Fatalf("打开瞬间应是加载中（先渲染加载态），实际 %s", ov.state)
	}
	if cmd == nil {
		t.Fatal("打开应发出 environment/list 命令")
	}

	m = pump(t, m, cmd)
	if ov.state != loadReady || len(ov.rows) != 2 {
		t.Fatalf("加载后应就绪且有 2 条，实际 %s / %d", ov.state, len(ov.rows))
	}
	if ov.rows[1].Title != "kali" || !strings.Contains(ov.rows[1].Desc, "10.0.0.5") {
		t.Fatalf("环境行折叠不对：%+v", ov.rows[1])
	}

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	if ov.sel != 1 {
		t.Fatalf("↓ 应选第二条，实际 %d", ov.sel)
	}

	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("Enter 应发出 environment/select")
	}
	m = pump(t, m, cmd)

	if len(fa.selected) != 1 {
		t.Fatalf("应调用一次 SelectEnvironment，实际 %d", len(fa.selected))
	}
	if got := fa.selected[0]; got[0] != "/tmp/ws" || got[1] != "kali" {
		t.Fatalf("SelectEnvironment 参数不对（workspace 必须来自 chat:init）：%v", got)
	}
	if _, ok := lastOverlayOf[*envOverlay](&m); ok {
		t.Fatal("切换成功后应关面板")
	}
	if !strings.Contains(m.LastNotice, "kali") {
		t.Fatalf("状态行应提示切换结果，实际 %q", m.LastNotice)
	}
}

func TestEnvOverlayLoadFailureKeepsPanel(t *testing.T) {
	fa := &fakeAdmin{envsErr: errors.New("environment/list boom")}
	m := adminModel(fa)

	m, cmd := m.Update(alt('e'))
	m = pump(t, m, cmd)

	ov, ok := lastOverlayOf[*envOverlay](&m)
	if !ok {
		t.Fatal("加载失败不该关面板")
	}
	if ov.state != loadFailed {
		t.Fatalf("应为 failed，实际 %s", ov.state)
	}
	if !strings.Contains(ov.err, "boom") {
		t.Fatalf("错误信息没留住：%q", ov.err)
	}
	if out := m.View(); !strings.Contains(out, "boom") {
		t.Fatalf("画面上应显示错误行：\n%s", out)
	}
	// 失败之后还能刷新（r），不该卡死。
	if _, cmd := m.Update(runes("r")); cmd == nil {
		t.Fatal("失败态按 r 应重新加载")
	}
}

func TestEnvSelectFailureStaysOpenWithNote(t *testing.T) {
	fa := &fakeAdmin{
		envs:      []client.EnvironmentInfo{{ID: "kali", Kind: "ssh", Host: "h"}},
		selectErr: errors.New("探活失败"),
	}
	m := adminModel(fa)
	m, cmd := m.Update(alt('e'))
	m = pump(t, m, cmd)

	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = pump(t, m, cmd)

	ov, ok := lastOverlayOf[*envOverlay](&m)
	if !ok {
		t.Fatal("切换失败不该关面板（用户要能换一个重试）")
	}
	if !strings.Contains(ov.note, "探活失败") {
		t.Fatalf("面板里应有失败提示，实际 %q", ov.note)
	}
	if !strings.Contains(m.LastErr, "探活失败") {
		t.Fatalf("状态行也应有失败提示，实际 %q", m.LastErr)
	}
}

func TestEnvOverlayRequiresWorkspace(t *testing.T) {
	fa := &fakeAdmin{envs: []client.EnvironmentInfo{{ID: "kali", Kind: "ssh"}}}
	m := adminModel(fa)
	m.Workspace = "" // 还没收到 chat:init
	m, cmd := m.Update(alt('e'))
	m = pump(t, m, cmd)

	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatal("workspace 未知时不该发注定被拒的请求")
	}
	ov, _ := lastOverlayOf[*envOverlay](&m)
	if !strings.Contains(ov.note, "workspace") {
		t.Fatalf("应提示 workspace 未知，实际 %q", ov.note)
	}
}

func TestChatInitRecordsWorkspace(t *testing.T) {
	m := feed(testModel(), protocol.Event{
		Kind: protocol.KindInit, SessionState: "idle", AgentDir: "/tmp/agent",
	})
	if m.Workspace != "/tmp/agent" {
		t.Fatalf("chat:init 的 agentDir 应成为 workspace，实际 %q", m.Workspace)
	}
}

// ── 线面板 ─────────────────────────────────────────────────────────────

func TestLineOverlayOpenSwitchResetsLine(t *testing.T) {
	fa := &fakeAdmin{sessions: []client.SessionInfo{
		{ID: "s1", Title: "旧线", LastActiveAt: "2026-01-01T10:00:00.000Z",
			Stats: &client.SessionStats{MessageCount: 7}},
		{ID: "s2", Title: "新线", Archived: true},
	}}
	m := adminModel(fa)
	// 旧线的残留内容必须被切线清掉。
	m.Store.Upsert(store.Block{ID: "msg:0", Kind: store.KindUser, Version: 1, Body: "旧内容"})
	m.ContextUsed, m.ContextWindow = 1000, 2000

	m, cmd := m.Update(alt('l'))
	m = pump(t, m, cmd)
	ov, ok := lastOverlayOf[*lineOverlay](&m)
	if !ok || ov.state != loadReady || len(ov.rows) != 2 {
		t.Fatalf("线面板没加载出 2 条：%+v", ov)
	}
	if !strings.Contains(ov.rows[0].Desc, "7 条") {
		t.Fatalf("行应显示消息数：%q", ov.rows[0].Desc)
	}
	if ov.rows[1].Flag != "已归档" {
		t.Fatalf("归档行应带标记：%+v", ov.rows[1])
	}

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = pump(t, m, cmd)

	if len(fa.switched) != 1 || fa.switched[0] != "s2" {
		t.Fatalf("应切换到 s2，实际 %v", fa.switched)
	}
	if _, ok := lastOverlayOf[*lineOverlay](&m); ok {
		t.Fatal("切线成功后应关面板")
	}
	if m.Store.Len() != 0 {
		t.Fatalf("切线必须清空旧块表（否则新线重放会命中旧内容），实际 %d 块", m.Store.Len())
	}
	if m.ContextUsed != 0 || m.ContextWindow != 0 {
		t.Fatalf("切线应清空上下文用量，实际 %d/%d", m.ContextUsed, m.ContextWindow)
	}
}

func TestSwitchBumpsSubGenAndResubscribes(t *testing.T) {
	fa := &fakeAdmin{sessions: []client.SessionInfo{{ID: "s1", Title: "线"}}}
	m := adminModel(fa)
	before := m.SubGen

	// 直接用结果消息验证善后（切线成功路径）。
	m, cmd := m.Update(lineSwitchMsg{sessionID: "s1"})
	if m.SubGen != before+1 {
		t.Fatalf("切线后订阅代次应 +1（旧通道作废），实际 %d → %d", before, m.SubGen)
	}
	if cmd == nil {
		t.Fatal("切线后应重新订阅 /chat/stream")
	}
	if m.Connected {
		t.Fatal("重连前应标记未连接")
	}
}

func TestLineSwitchFailureKeepsPanel(t *testing.T) {
	fa := &fakeAdmin{
		sessions:  []client.SessionInfo{{ID: "s1", Title: "线"}},
		switchErr: errors.New("目标线在跑"),
	}
	m := adminModel(fa)
	m, cmd := m.Update(alt('l'))
	m = pump(t, m, cmd)
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = pump(t, m, cmd)

	ov, ok := lastOverlayOf[*lineOverlay](&m)
	if !ok {
		t.Fatal("切线失败不该关面板")
	}
	if !strings.Contains(ov.note, "目标线在跑") {
		t.Fatalf("面板里应有失败提示，实际 %q", ov.note)
	}
}

// ── 任务面板 ───────────────────────────────────────────────────────────

func TestTaskOverlayListsAndEnterOpensDetail(t *testing.T) {
	fa := &fakeAdmin{tasks: []client.TaskInfo{
		{ID: "t1", Name: "扫一遍 CVE", Status: "running", Executor: "agent", Tags: []string{"recon"}},
		{ID: "t2", Name: "写报告", Status: "done", Executor: "agent"},
	}}
	m := adminModel(fa)
	m, cmd := m.Update(alt('t'))
	m = pump(t, m, cmd)

	ov, ok := lastOverlayOf[*taskOverlay](&m)
	if !ok || len(ov.rows) != 2 {
		t.Fatalf("任务面板没加载出 2 条：%+v", ov)
	}
	if ov.rows[0].Flag != "running" || !strings.Contains(ov.rows[0].Desc, "#recon") {
		t.Fatalf("任务行折叠不对：%+v", ov.rows[0])
	}
	if !ov.rows[1].Dim {
		t.Fatal("done 行应弱化显示")
	}

	fa.taskDetail = client.TaskDetail{ID: "t1", Name: "扫一遍 CVE", Status: "running",
		WorkspacePath: "/ws", StatusHistory: []client.TaskStatusTransition{{To: "running", At: 1}}}
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("Enter 应拉任务详情")
	}
	msg := cmd()
	m, _ = m.Update(msg)
	if _, ok := lastOverlayOf[*detailOverlay](&m); !ok {
		t.Fatalf("应打开详情面板，实际 %T", msg)
	}
	if out := m.View(); !strings.Contains(out, "扫一遍 CVE") || !strings.Contains(out, "/ws") {
		t.Fatalf("详情应显示名称与工作区：\n%s", out)
	}
}

func TestTaskOverlayLoadFailure(t *testing.T) {
	fa := &fakeAdmin{tasksErr: errors.New("management api 未启动")}
	m := adminModel(fa)
	m, cmd := m.Update(alt('t'))
	m = pump(t, m, cmd)

	ov, _ := lastOverlayOf[*taskOverlay](&m)
	if ov.state != loadFailed || !strings.Contains(ov.err, "management") {
		t.Fatalf("失败应留在面板里：%+v", ov)
	}
}

// ── 档案面板 ───────────────────────────────────────────────────────────

func TestArchiveOverlayGroupsByKind(t *testing.T) {
	fa := &fakeAdmin{archive: []client.ArchiveEntity{
		{ID: "V#1", Kind: "evidence", Text: "端口 22 开放", Status: "active"},
		{ID: "C#1", Kind: "finding", Text: "存在弱口令", Status: "open", NeedsReview: true},
		{ID: "H#1", Kind: "hypothesis", Text: "可能存在默认口令", Status: "active"},
		{ID: "Q#1", Kind: "question", Text: "要不要继续深挖？", Status: "open"},
		{ID: "Z#1", Kind: "custom", Text: "未知类型", Status: "active"},
	}}
	m := adminModel(fa)
	m, cmd := m.Update(alt('a'))
	m = pump(t, m, cmd)

	ov, ok := lastOverlayOf[*archiveOverlay](&m)
	if !ok || ov.state != loadReady {
		t.Fatalf("档案面板没就绪：%+v", ov)
	}
	if got := len(ov.groups); got != 5 {
		t.Fatalf("应有 5 组（4 种已知 + 1 种未知），实际 %d", got)
	}
	wantOrder := []string{"hypothesis", "finding", "evidence", "question", "custom"}
	for i, want := range wantOrder {
		if ov.groups[i].kind != want {
			t.Fatalf("第 %d 组应是 %s，实际 %s（顺序必须固定）", i, want, ov.groups[i].kind)
		}
	}
	if s := ov.Summary(); s.Count != 5 || !strings.Contains(s.First, "H#1") {
		t.Fatalf("摘要不对：%+v", s)
	}
	// 待复核的结论要能看出来。
	finding := ov.groups[1].rows[0]
	if !strings.Contains(finding.Flag, "待复核") || !finding.Dim {
		t.Fatalf("待复核结论应带标记且弱化：%+v", finding)
	}

	out := m.View()
	if !strings.Contains(out, "假设") || !strings.Contains(out, "结论") || !strings.Contains(out, "H#1") {
		t.Fatalf("画面上应有分组与实体：\n%s", out)
	}
}

func TestArchiveOverlayRequestsCurrentLine(t *testing.T) {
	fa := &fakeAdmin{}
	m := adminModel(fa)
	m, cmd := m.Update(alt('a'))
	_ = pump(t, m, cmd)
	if len(fa.archiveSIDs) != 1 || fa.archiveSIDs[0] != "ls-1" {
		t.Fatalf("archive/list 应带当前 sessionId，实际 %v", fa.archiveSIDs)
	}
}

func TestArchiveOverlayReadOnlyKeys(t *testing.T) {
	fa := &fakeAdmin{archive: []client.ArchiveEntity{{ID: "H#1", Kind: "hypothesis", Text: "t"}}}
	m := adminModel(fa)
	m, cmd := m.Update(alt('a'))
	m = pump(t, m, cmd)

	// 只读树：任何按键都不改变状态、不关面板。
	for _, k := range []tea.KeyMsg{{Type: tea.KeyDown}, {Type: tea.KeyEnter}, runes("x")} {
		m2, cmd := m.Update(k)
		if cmd != nil {
			t.Fatalf("%q 不该产生命令（只读）", k.String())
		}
		if _, ok := lastOverlayOf[*archiveOverlay](&m2); !ok {
			t.Fatalf("%q 不该关面板", k.String())
		}
	}
}

// ── 栈 ─────────────────────────────────────────────────────────────────

func TestOverlayStackPushAndPopOneAtATime(t *testing.T) {
	fa := &fakeAdmin{archive: []client.ArchiveEntity{{ID: "H#1", Kind: "hypothesis", Text: "t"}}}
	m := adminModel(fa)

	// Ctrl+K 开面板 → 在面板里选"打开研究档案"
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	if _, ok := lastOverlayOf[*paletteOverlay](&m); !ok {
		t.Fatal("第一层应是命令面板")
	}
	for _, r := range "档案" {
		m, _ = m.Update(runes(string(r)))
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if _, ok := lastOverlayOf[*archiveOverlay](&m); !ok {
		t.Fatal("面板条目应压入档案面板")
	}
	if len(m.Overlays) != 1 {
		// 面板执行后面板自己关掉，档案顶上来 —— 栈里只剩档案。
		t.Fatalf("执行面板条目后栈里应只剩档案，实际 %d 层", len(m.Overlays))
	}
	m = pump(t, m, cmd)

	// Esc 只关一层。
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if _, ok := m.TopOverlay(); ok {
		t.Fatalf("Esc 一次应关掉档案，实际还剩 %d 层", len(m.Overlays))
	}

	// 栈空后按键回到输入框。
	m, _ = m.Update(runes("a"))
	if m.Input.Value() != "a" {
		t.Fatalf("栈空后字符应进输入框，实际 %q", m.Input.Value())
	}
}

func TestOverlayEscClosesOnlyTopLayer(t *testing.T) {
	m := testModel()
	m.PushOverlay(newNoticeOverlay("动作层", "x"))
	m.PushOverlay(newPaletteOverlay())

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if len(m.Overlays) != 1 {
		t.Fatalf("Esc 应只关一层，实际剩 %d 层", len(m.Overlays))
	}
	if _, ok := lastOverlayOf[*paletteOverlay](&m); ok {
		t.Fatal("先关的应该是栈顶的命令面板")
	}
	if _, ok := lastOverlayOf[*noticeOverlay](&m); !ok {
		t.Fatal("下层应还在")
	}
}

// ── 无管理面客户端 ─────────────────────────────────────────────────────

func TestOverlaysFailGracefullyWithoutAdmin(t *testing.T) {
	cases := []struct {
		key  tea.KeyMsg
		want func(Model) Summary
	}{
		{alt('e'), func(m Model) Summary {
			ov, _ := lastOverlayOf[*envOverlay](&m)
			return ov.Summary()
		}},
		{alt('l'), func(m Model) Summary {
			ov, _ := lastOverlayOf[*lineOverlay](&m)
			return ov.Summary()
		}},
		{alt('t'), func(m Model) Summary {
			ov, _ := lastOverlayOf[*taskOverlay](&m)
			return ov.Summary()
		}},
		{alt('a'), func(m Model) Summary {
			ov, _ := lastOverlayOf[*archiveOverlay](&m)
			return ov.Summary()
		}},
	}
	for _, c := range cases {
		m := testModel() // Admin 为 nil
		m2, cmd := m.Update(c.key)
		if cmd != nil {
			t.Fatalf("%q 没有管理面客户端时不该发请求", c.key.String())
		}
		s := c.want(m2)
		if s.State != "failed" || s.Err == "" {
			t.Fatalf("%q 应落到失败态并带原因，实际 %+v", c.key.String(), s)
		}
		if _, ok := m2.TopOverlay(); !ok {
			t.Fatalf("%q 失败也要留在面板里（不能静默关掉）", c.key.String())
		}
	}
}

// task/list 必须带 includeSystem：系统任务（蒸馏弧这类）恰恰是"现在真在跑
// 的东西"，默认隐藏会让面板永远是空表。徽记用 `sys ·` 前缀区分，不和用户
// 自己建的任务混在一起看。
func TestTaskOverlayShowsSystemTasksWithBadge(t *testing.T) {
	fa := &fakeAdmin{tasks: []client.TaskInfo{
		{ID: "t1", Name: "蒸馏弧", Status: "running", Executor: "agent", DispatchOrigin: "system"},
		{ID: "t2", Name: "我的任务", Status: "todo", Executor: "user"},
	}}
	m := adminModel(fa)
	m, cmd := m.Update(alt('t'))
	m = pump(t, m, cmd)

	ov, ok := lastOverlayOf[*taskOverlay](&m)
	if !ok || len(ov.rows) != 2 {
		t.Fatalf("任务面板应加载 2 条（含系统任务）：%+v", ov)
	}
	if !strings.HasPrefix(ov.rows[0].Desc, "sys · ") {
		t.Fatalf("系统任务行应有 sys 徽记，实际 %q", ov.rows[0].Desc)
	}
	if strings.Contains(ov.rows[1].Desc, "sys") {
		t.Fatalf("用户任务不该带 sys 徽记，实际 %q", ov.rows[1].Desc)
	}
}

// ── P0 新增的写接口（任务 / 会话 / 模型）────────────────────────────────

func (f *fakeAdmin) TaskUpdateStatus(_ context.Context, id, status, message string) error {
	f.taskOps = append(f.taskOps, "status:"+id+":"+status)
	return f.taskOpErr
}

func (f *fakeAdmin) TaskRerun(_ context.Context, id string) error {
	f.taskOps = append(f.taskOps, "rerun:"+id)
	return f.taskOpErr
}

func (f *fakeAdmin) Models(context.Context) ([]client.ModelOption, error) {
	return f.models, f.modelsErr
}

func (f *fakeAdmin) ChatModel(_ context.Context, providerID, model string) error {
	f.chatModels = append(f.chatModels, providerID+"/"+model)
	return f.chatModelErr
}

func (f *fakeAdmin) ResetChat(context.Context) error {
	f.reset++
	return f.sessionOpErr
}

func (f *fakeAdmin) Rewind(_ context.Context, id string) error {
	f.rewinds = append(f.rewinds, id)
	return f.sessionOpErr
}

func (f *fakeAdmin) CancelQueueItem(_ context.Context, id string) error {
	f.queueCancels = append(f.queueCancels, id)
	return f.queueCancelErr
}

func (f *fakeAdmin) Fork(_ context.Context, id string) error {
	f.forks = append(f.forks, id)
	return f.sessionOpErr
}

// ── auto-run 观察面（P2-a）──────────────────────────────────────────────

func (f *fakeAdmin) AutoRunShow(_ context.Context, id string) (client.AutoRunInfo, error) {
	if f.autoRunErr != nil {
		return client.AutoRunInfo{}, f.autoRunErr
	}
	return f.autoRun, nil
}

func (f *fakeAdmin) AutoRunList(_ context.Context, _ string) ([]client.AutoRunInfo, error) {
	return f.autoRuns, f.autoRunErr
}

func (f *fakeAdmin) AutoRunStart(_ context.Context, name, goal, envKey, kind string, limit float64, criteria []string) (string, error) {
	f.autoRunStarts = append(f.autoRunStarts, name+"|"+envKey+"|"+kind)
	if f.autoRunStartErr != nil {
		return "", f.autoRunStartErr
	}
	return "run-1", nil
}

func (f *fakeAdmin) AutoRunStop(_ context.Context, id string) error {
	f.autoRunStops = append(f.autoRunStops, id)
	return f.autoRunStopErr
}

func (f *fakeAdmin) ReportExport(_ context.Context, workspace string, sanitize bool) (client.ReportExportInfo, error) {
	f.reportWorkspaces = append(f.reportWorkspaces, workspace)
	if f.reportErr != nil {
		return client.ReportExportInfo{}, f.reportErr
	}
	return f.reportInfo, nil
}

func (f *fakeAdmin) EnvDown(_ context.Context, id string) error {
	f.envOps = append(f.envOps, "down:"+id)
	return f.envOpErr
}

func (f *fakeAdmin) EnvRm(_ context.Context, id string) error {
	f.envOps = append(f.envOps, "rm:"+id)
	return f.envOpErr
}

func (f *fakeAdmin) EnvRename(_ context.Context, id, name string) error {
	f.envOps = append(f.envOps, "rename:"+id+":"+name)
	return f.envOpErr
}

func (f *fakeAdmin) EnvRecipes(context.Context) ([]client.EnvRecipe, error) {
	return f.recipes, f.envOpErr
}

func (f *fakeAdmin) ArchiveCorrect(_ context.Context, sessionID, id, reason string) error {
	f.archiveOps = append(f.archiveOps, "correct:"+id+":"+reason)
	return f.archiveOpErr
}

func (f *fakeAdmin) ArchiveResolve(_ context.Context, sessionID, id, note string) error {
	f.archiveOps = append(f.archiveOps, "resolve:"+id)
	return f.archiveOpErr
}

func (f *fakeAdmin) ArchiveAbandon(_ context.Context, sessionID, id, reason string) error {
	f.archiveOps = append(f.archiveOps, "abandon:"+id+":"+reason)
	return f.archiveOpErr
}

func (f *fakeAdmin) SearchMemory(_ context.Context, q string) ([]client.MemoryHit, error) {
	f.searchQueries = append(f.searchQueries, "memory:"+q)
	return f.memoryHits, f.searchErr
}

func (f *fakeAdmin) SearchExpert(_ context.Context, q string) ([]client.ExpertHit, error) {
	f.searchQueries = append(f.searchQueries, "expert:"+q)
	return f.expertHits, f.searchErr
}

func (f *fakeAdmin) SearchIntel(_ context.Context, q string) (string, int, error) {
	f.searchQueries = append(f.searchQueries, "intel:"+q)
	return f.intelText, f.intelCount, f.searchErr
}

func (f *fakeAdmin) SessionPatch(_ context.Context, id string, patch map[string]any) error {
	f.sessionPatches = append(f.sessionPatches, id)
	if f.sessionPatchErr != nil {
		return f.sessionPatchErr
	}
	return nil
}

func (f *fakeAdmin) SessionDelete(_ context.Context, id string) error {
	f.sessionDeletes = append(f.sessionDeletes, id)
	return f.sessionDeleteErr
}

func (f *fakeAdmin) TaskGet(_ context.Context, id string) (client.TaskDetail, error) {
	f.taskGets = append(f.taskGets, id)
	return f.taskDetail, f.taskGetErr
}

package app

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/protocol"
	"github.com/lielingai/zhishi/tui/internal/store"
)

// ── 折叠 / 展开 ────────────────────────────────────────────────────────

// longToolModel 造一个有长正文的工具块（20 行，折叠态只显示 6 行 + 省略行）。
func longToolModel(t *testing.T) Model {
	t.Helper()
	m := testModel()
	var lines []string
	for i := 0; i < 20; i++ {
		lines = append(lines, "line")
	}
	m.Store.Upsert(store.Block{
		ID: "tool:t1", Kind: store.KindTool, Title: "Bash", Version: 1,
		Body: strings.Join(lines, "\n"),
	})
	m.layout()
	return m
}

func TestFoldExpandFoldCycle(t *testing.T) {
	m := longToolModel(t)

	folded := m.View()
	if !strings.Contains(folded, "还有 20 行（Alt+r）") {
		t.Fatalf("默认应是折叠态（正文全隐藏 + 块头摘要）：\n%s", folded)
	}
	if n := strings.Count(folded, "line"); n != 1 { // 只剩块头里的首行摘要
		t.Fatalf("折叠态应只显示 1 行正文，实际 %d 行", n)
	}

	m, _ = m.Update(alt('r')) // 展开
	expanded := m.View()
	if strings.Contains(expanded, "还有") {
		t.Fatalf("展开后不该再有省略提示：\n%s", expanded)
	}
	if n := strings.Count(expanded, "line"); n != 20 {
		t.Fatalf("展开态应显示全部 20 行，实际 %d 行", n)
	}
	if b, _ := m.Store.Get("tool:t1"); !b.Expanded {
		t.Fatal("Expanded 没置位")
	}

	m, _ = m.Update(alt('r')) // 再折回
	refolded := m.View()
	if !strings.Contains(refolded, "还有 20 行（Alt+r）") {
		t.Fatalf("再按一次应回到折叠态：\n%s", refolded)
	}
	if b, _ := m.Store.Get("tool:t1"); b.Expanded {
		t.Fatal("Expanded 没复位")
	}
}

// ── 鼠标 ───────────────────────────────────────────────────────────────

// headRow 找出某个块在画面上块头那一行的行号（相对终端）。
func headRow(t *testing.T, m Model, id string) int {
	t.Helper()
	for i, r := range m.Frame.rows {
		if r.ID == id && r.Head {
			return m.Frame.streamTop + i
		}
	}
	t.Fatalf("画面上找不到 %q 的块头行", id)
	return 0
}

func TestMouseClickOnBlockHeadToggles(t *testing.T) {
	m := longToolModel(t)
	_ = m.View() // 渲染一帧，建立行 → 块的投影

	y := headRow(t, m, "tool:t1")
	m, _ = m.Update(tea.MouseMsg{
		Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: 3, Y: y,
	})
	if b, _ := m.Store.Get("tool:t1"); !b.Expanded {
		t.Fatal("点块头应展开")
	}

	_ = m.View()
	y = headRow(t, m, "tool:t1")
	m, _ = m.Update(tea.MouseMsg{
		Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: 3, Y: y,
	})
	if b, _ := m.Store.Get("tool:t1"); b.Expanded {
		t.Fatal("再点块头应折叠")
	}
}

func TestMouseClickOnBodyDoesNothing(t *testing.T) {
	m := longToolModel(t)
	_ = m.View()
	y := headRow(t, m, "tool:t1") + 2 // 正文行，不是块头

	m, _ = m.Update(tea.MouseMsg{
		Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: 3, Y: y,
	})
	if b, _ := m.Store.Get("tool:t1"); b.Expanded {
		t.Fatal("点正文不该切换折叠（会让人选不了文本）")
	}
}

func TestMouseClickOutsideStreamIsIgnored(t *testing.T) {
	m := longToolModel(t)
	_ = m.View()
	before, _ := m.Store.Get("tool:t1")

	m, _ = m.Update(tea.MouseMsg{
		Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: 3, Y: 0, // header 行
	})
	after, _ := m.Store.Get("tool:t1")
	if before.Expanded != after.Expanded {
		t.Fatal("点到 header 不该改变任何块")
	}
}

func TestMouseWheelScrolls(t *testing.T) {
	// 造出比视口更高的内容：折叠后的工具块 1 行/个，14 个 > 视口 9 行。
	m := testModel()
	for i := 0; i < 14; i++ {
		m = feed(m, toolEventFor(i))
	}
	m.Height = 16
	m.layout()
	_ = m.View()
	if m.maxScrollLines() < mouseScroll {
		t.Fatalf("前置条件：可滚量不足（%d）", m.maxScrollLines())
	}

	m, _ = m.Update(tea.MouseMsg{
		Action: tea.MouseActionPress, Button: tea.MouseButtonWheelUp, X: 1, Y: 3,
	})
	if m.ScrollLines != mouseScroll {
		t.Fatalf("滚轮上应滚 %d 行，实际 %d", mouseScroll, m.ScrollLines)
	}
	m, _ = m.Update(tea.MouseMsg{
		Action: tea.MouseActionPress, Button: tea.MouseButtonWheelDown, X: 1, Y: 3,
	})
	if m.ScrollLines != 0 {
		t.Fatalf("滚轮回应回到底部，实际 %d", m.ScrollLines)
	}
	// 已经在底部：继续往下滚不该变成负数。
	m, _ = m.Update(tea.MouseMsg{
		Action: tea.MouseActionPress, Button: tea.MouseButtonWheelDown, X: 1, Y: 3,
	})
	if m.ScrollLines != 0 {
		t.Fatalf("底部不该滚出负数：%d", m.ScrollLines)
	}
}

// ── Alt+o 外部打开 ─────────────────────────────────────────────────────

func TestExternalOpenWritesTempAndCallsOpener(t *testing.T) {
	m := longToolModel(t)
	var opened string
	m.Open = func(path string) *exec.Cmd {
		opened = path
		return exec.Command("true") // 只是构造，测试里绝不启动
	}

	m, cmd := m.Update(alt('o'))
	if cmd == nil {
		t.Fatal("Alt+o 应发出写文件命令")
	}
	msg := cmd()
	req, ok := msg.(openRequestMsg)
	if !ok {
		t.Fatalf("应回 openRequestMsg，实际 %T", msg)
	}
	if req.err != nil {
		t.Fatalf("写临时文件失败：%v", req.err)
	}
	data, err := os.ReadFile(req.path)
	if err != nil {
		t.Fatalf("临时文件读不到：%v", err)
	}
	if !strings.Contains(string(data), "line") {
		t.Fatalf("临时文件内容不对：%q", string(data))
	}

	m, cmd = m.Update(req)
	if cmd == nil {
		t.Fatal("落盘后应发出外部打开命令")
	}
	if opened != req.path {
		t.Fatalf("opener 收到的路径不对：%q vs %q", opened, req.path)
	}
	if !strings.Contains(m.LastNotice, req.path) {
		t.Fatalf("状态行应提示临时文件路径，实际 %q", m.LastNotice)
	}
	// ExecProcess 的 Cmd 只返回一条内部消息，不会真的起进程。
	if got := typeName(cmd()); got != "execMsg" {
		t.Fatalf("应当是 tea.ExecProcess（内部 execMsg），实际 %s", got)
	}

	m, _ = m.Update(openDoneMsg{})
	if m.LastNotice != "已从外部程序返回" {
		t.Fatalf("外部程序退出后应回提示，实际 %q", m.LastNotice)
	}
}

func TestExternalOpenReportsWriteFailure(t *testing.T) {
	m := longToolModel(t)
	m, _ = m.Update(openRequestMsg{err: errors.New("磁盘只读")})
	if !strings.Contains(m.LastErr, "磁盘只读") {
		t.Fatalf("落盘失败应进状态行，实际 %q", m.LastErr)
	}
}

// ── Alt+y 复制 ─────────────────────────────────────────────────────────

func TestCopyFallsBackToTempFileWhenNotTTY(t *testing.T) {
	// go test 里 stdout 是管道，不是字符设备 → 走降级路径。
	if stdoutIsTerminal() {
		t.Skip("stdout 是终端，跳过降级路径")
	}
	msg := copyCmd("hello copy")()
	notice, ok := msg.(noticeMsg)
	if !ok {
		t.Fatalf("应回 noticeMsg，实际 %T", msg)
	}
	if !strings.Contains(string(notice), "临时文件") {
		t.Fatalf("非终端时应退化为临时文件，实际 %q", notice)
	}
	path := filepath.Join(os.TempDir(), "zhishi-tui", "copy.txt")
	if !strings.Contains(string(notice), path) {
		t.Fatalf("提示里应带降级文件路径 %q，实际 %q", path, notice)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("降级文件读不到：%v", err)
	}
	if string(data) != "hello copy" {
		t.Fatalf("降级文件内容不对：%q", string(data))
	}
}

func TestOSC52SequenceShape(t *testing.T) {
	// OSC52 的字节形状是终端契约：ESC ] 52 ; c ; <base64> BEL
	if got, want := osc52("hi"), "\x1b]52;c;aGk=\x07"; got != want {
		t.Fatalf("OSC52 序列不对：%q，期望 %q", got, want)
	}
}

func TestCopyEmptyNotices(t *testing.T) {
	msg := copyCmd("")()
	if n, ok := msg.(noticeMsg); !ok || n == "" {
		t.Fatalf("空内容应回提示，实际 %v", msg)
	}
}

// ── Alt+f 只看失败 ─────────────────────────────────────────────────────

func TestOnlyFailedFilterDrivesRendering(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindMessageChunk, Text: "ok-output"},
		protocol.Event{Kind: protocol.KindToolResult, ToolUseID: "t", ToolOutput: "broken-output", IsError: true},
	)
	if out := m.View(); !strings.Contains(out, "ok-output") || !strings.Contains(out, "broken-output") {
		t.Fatalf("默认应看到两块：\n%s", out)
	}

	m, _ = m.Update(alt('f'))
	out := m.View()
	if strings.Contains(out, "ok-output") {
		t.Fatalf("只看失败时不该渲染成功块：\n%s", out)
	}
	if !strings.Contains(out, "broken-output") {
		t.Fatalf("只看失败时应渲染失败块：\n%s", out)
	}
}

// ── 状态行 ─────────────────────────────────────────────────────────────

// statusModel 把状态行的五个数据源都喂满。
func statusModel(t *testing.T) Model {
	t.Helper()
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindContextUsage, ContextUsed: 102400, ContextWindow: 250000},
		protocol.Event{Kind: protocol.KindMessageComplete, Model: "deepseek-flash",
			InputTokens: 100000, OutputTokens: 24000, DurationMS: 312000},
		protocol.Event{Kind: protocol.KindQueueAdded, QueueID: "q1"},
		protocol.Event{Kind: protocol.KindQueueAdded, QueueID: "q2"},
		protocol.Event{Kind: protocol.KindSubagentStart, TaskID: "s1"},
	)
	return m
}

func TestStatusLineFormat(t *testing.T) {
	m := statusModel(t)
	line := m.statusLine()
	// ctx% 与 a/b 同源自 context-usage 快照；Σ 是 usage 累计——两段各说一件事。
	// 「选择」徽记表示鼠标在终端手里（默认态）；窄屏时它和子任务一起先被丢掉。
	want := "INSERT  deepseek-flash  ctx 40%  102k/250k  Σ 124k  队列 2  5m12s  1 子任务"
	if !strings.Contains(line, want) {
		t.Fatalf("状态行格式不对：实际 %q，期望含 %q", line, want)
	}
}

func TestStatusLineSnapshotAndSigmaAreIndependent(t *testing.T) {
	// 只有 usage、没有快照：Σ 有值，ctx / a-b 两段整体缺席（不编造窗口）。
	m := feed(testModel(), protocol.Event{
		Kind: protocol.KindMessageComplete, InputTokens: 1000, OutputTokens: 200, DurationMS: 1000,
	})
	line := m.statusLine()
	if !strings.Contains(line, "Σ 1k") {
		t.Fatalf("usage 累计应显示 Σ 1k：%s", line)
	}
	if strings.Contains(line, "ctx ") || strings.Contains(line, "0/0") {
		t.Fatalf("没有 context-usage 快照时不该出现 ctx / a-b 段：%s", line)
	}
}

func TestStatusLineShowsDashWithoutUsage(t *testing.T) {
	m := testModel()
	line := m.statusLine()
	if !strings.Contains(line, "INSERT") || !strings.Contains(line, "Σ -") {
		t.Fatalf("没有 usage 时 Σ 段应显示 -，实际 %q", line)
	}
}

func TestStatusLineDegradesNarrow(t *testing.T) {
	m := statusModel(t)

	// 80 列：只丢子任务（分隔符从 " · " 改成两个空格后，阈值跟着变窄）。
	m.Width = 74
	line := m.statusLine()
	if strings.Contains(line, "子任务") {
		t.Fatalf("窄屏应先丢子任务：%s", line)
	}
	if !strings.Contains(line, "Σ 124k") || !strings.Contains(line, "102k/250k") {
		t.Fatalf("只丢子任务时 Σ 与上下文对数都应保留：%s", line)
	}

	// 60 列：再丢 Σ。
	m.Width = 62
	line = m.statusLine()
	if strings.Contains(line, "Σ") {
		t.Fatalf("第二级应丢 Σ：%s", line)
	}
	if !strings.Contains(line, "102k/250k") {
		t.Fatalf("丢 Σ 后上下文对数仍应保留：%s", line)
	}

	// 55 列：再丢上下文对数（ctx% 是永不丢的主干）。
	m.Width = 48
	line = m.statusLine()
	if strings.Contains(line, "102k") {
		t.Fatalf("第三级应丢上下文对数：%s", line)
	}
	if !strings.Contains(line, "ctx 40%") || !strings.Contains(line, "队列 2") {
		t.Fatalf("ctx%% 与队列应始终保留：%s", line)
	}
}

func TestQueueAndSubagentDedupe(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindQueueAdded, QueueID: "q1"},
		protocol.Event{Kind: protocol.KindQueueAdded, QueueID: "q1"}, // 重放
		protocol.Event{Kind: protocol.KindSubagentStart, TaskID: "s1"},
		protocol.Event{Kind: protocol.KindSubagentStart, TaskID: "s1"},
	)
	if got := m.QueuedCount(); got != 1 {
		t.Fatalf("同一 queueId 重放应只算一次，实际 %d", got)
	}
	if got := m.SubagentCount(); got != 1 {
		t.Fatalf("同一 taskId 重复开始应只算一次，实际 %d", got)
	}

	m = feed(m,
		protocol.Event{Kind: protocol.KindQueueCancelled, QueueID: "q1"},
		protocol.Event{Kind: protocol.KindSubagentDone, TaskID: "s1"},
	)
	if m.QueuedCount() != 0 || m.SubagentCount() != 0 {
		t.Fatalf("取消/结束应清零：队列 %d 子任务 %d", m.QueuedCount(), m.SubagentCount())
	}
}

func TestTickDrivesElapsedAndStopsWhenIdle(t *testing.T) {
	m := testModel()
	m, cmd := m.Update(EventMsg(protocol.Event{Kind: protocol.KindStatus, SessionState: "running"}))
	if cmd == nil {
		t.Fatal("turn 开跑时应挂上秒表")
	}
	if !m.Ticking || m.TaskStarted.IsZero() {
		t.Fatalf("秒表没起来：ticking=%v started=%v", m.Ticking, m.TaskStarted)
	}

	start := m.TaskStarted
	m, cmd = m.Update(tickMsg(start.Add(90 * time.Second)))
	if cmd == nil {
		t.Fatal("跑着的时候 tick 应继续")
	}
	if got := m.Elapsed(); got != 90*time.Second {
		t.Fatalf("时长应按 Now-TaskStarted 算，实际 %v", got)
	}

	m, _ = m.Update(EventMsg(protocol.Event{Kind: protocol.KindStatus, SessionState: "idle"}))
	m, cmd = m.Update(tickMsg(start.Add(91 * time.Second)))
	if cmd != nil {
		t.Fatal("turn 结束后不该再 tick")
	}
	if !m.Ticking {
		return // 已经置 false，符合预期
	}
	t.Fatal("turn 结束后 Ticking 应复位")
}

// ── Ctrl+K 命令面板 ────────────────────────────────────────────────────

func TestPaletteFilterSelectExecute(t *testing.T) {
	m := testModel()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	if _, ok := lastOverlayOf[*paletteOverlay](&m); !ok {
		t.Fatal("Ctrl+K 应压入命令面板")
	}

	for _, r := range "set-key" {
		m, _ = m.Update(runes(string(r)))
	}
	ov, _ := lastOverlayOf[*paletteOverlay](&m)
	if ov.query != "set-key" {
		t.Fatalf("输入应进面板查询串，实际 %q", ov.query)
	}
	items := filterPalette(ov.query, &m)
	if len(items) != 1 || items[0].Name != "/model set-key " {
		t.Fatalf("set-key 应只命中写 key 的模板，实际 %+v", items)
	}
	if out := m.View(); !strings.Contains(out, "/model set-key") || strings.Contains(out, "/status") {
		t.Fatalf("画面上应只剩过滤后的条目：\n%s", out)
	}

	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatal("模板条目只填输入框，不应立刻执行")
	}
	if _, ok := m.TopOverlay(); ok {
		t.Fatal("执行后应关面板")
	}
	if got := m.Input.Value(); got != "/model set-key " {
		t.Fatalf("输入框应被填入模板，实际 %q", got)
	}
	if !strings.Contains(m.LastNotice, "补完参数") {
		t.Fatalf("状态行应提示补参数，实际 %q", m.LastNotice)
	}
}

func TestPaletteArrowSelectionAndAction(t *testing.T) {
	m := testModel()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	if ov, _ := lastOverlayOf[*paletteOverlay](&m); ov.sel != 0 {
		t.Fatalf("初始选中应为 0，实际 %d", ov.sel)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	if ov, _ := lastOverlayOf[*paletteOverlay](&m); ov.sel != 2 {
		t.Fatalf("↓↓ 后应选第 3 项，实际 %d", ov.sel)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp})
	if ov, _ := lastOverlayOf[*paletteOverlay](&m); ov.sel != 1 {
		t.Fatalf("↑ 后应回第 2 项，实际 %d", ov.sel)
	}

	// 过滤到"跳到最后一块"再执行：应把滚动归零。
	for _, r := range "跳" {
		m, _ = m.Update(runes(string(r)))
	}
	m.ScrollLines = 42
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.ScrollLines != 0 {
		t.Fatalf("跳到最后一块应把滚动归零，实际 %d", m.ScrollLines)
	}
	if _, ok := m.TopOverlay(); ok {
		t.Fatal("执行后应关面板")
	}
}

func TestPaletteSelectClampedByFilter(t *testing.T) {
	m := testModel()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	for i := 0; i < 9; i++ {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	}
	if ov, _ := lastOverlayOf[*paletteOverlay](&m); ov.sel != 9 {
		t.Fatalf("应能选到第 10 项，实际 %d", ov.sel)
	}
	// 输入把列表缩到 1 条，选中项必须跟着收敛，否则 Enter 会执行不存在的位置。
	for _, r := range "exp" {
		m, _ = m.Update(runes(string(r)))
	}
	if ov, _ := lastOverlayOf[*paletteOverlay](&m); ov.sel != 0 {
		t.Fatalf("过滤后选中项应收敛到 0，实际 %d", ov.sel)
	}
}

func TestPaletteBackspaceEditsQuery(t *testing.T) {
	m := testModel()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	for _, r := range "ab" {
		m, _ = m.Update(runes(string(r)))
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	if ov, _ := lastOverlayOf[*paletteOverlay](&m); ov.query != "a" {
		t.Fatalf("退格应删掉最后一个字符，实际 %q", ov.query)
	}
}

func TestPaletteKeysDoNotLeakToInput(t *testing.T) {
	m := testModel()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	m, _ = m.Update(runes("x"))
	if m.Input.Value() != "" {
		t.Fatalf("面板打开时按键不该进输入框，实际 %q", m.Input.Value())
	}
}

func TestRouteOverlayPaletteGetsKeys(t *testing.T) {
	m := testModel()
	m.PushOverlay(newPaletteOverlay())
	if got := Route(m, runes("a")); got != ActionOverlayKey {
		t.Fatalf("面板打开时字符应交给面板，实际 %v", got)
	}
	if got := Route(m, tea.KeyMsg{Type: tea.KeyEsc}); got != ActionCloseOverlay {
		t.Fatalf("Esc 仍应关面板，实际 %v", got)
	}
	if got := Route(m, alt('j')); got != ActionOverlayKey {
		t.Fatalf("全局键在面板打开时不该生效，实际 %v", got)
	}
}

// typeName 取消息的动态类型名（用来断言"发的是哪条命令"）。
func typeName(msg tea.Msg) string {
	if msg == nil {
		return "<nil>"
	}
	name := strings.TrimPrefix(fmt.Sprintf("%T", msg), "*")
	name = strings.TrimPrefix(name, "app.")
	return strings.TrimPrefix(name, "tea.")
}

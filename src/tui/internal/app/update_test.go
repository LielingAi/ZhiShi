package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/protocol"
	"github.com/lielingai/zhishi/tui/internal/store"
)

func testModel() Model {
	m := NewModel("http://127.0.0.1:7411", nil)
	m.Width, m.Height = 100, 30
	m.layout()
	return m
}

func alt(r rune) tea.KeyMsg {
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}, Alt: true}
}

func runes(s string) tea.KeyMsg {
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
}

// feed 把事件喂进归约器，忽略 Cmd（探针也是这么用的）。
func feed(m Model, evs ...protocol.Event) Model {
	for _, ev := range evs {
		m, _ = m.Update(EventMsg(ev))
	}
	return m
}

// ── 键路由三段式 ────────────────────────────────────────────────────────

func TestRouteOverlayTopWins(t *testing.T) {
	m := testModel()
	m.PushOverlay(newNoticeOverlay("命令面板", "x"))
	m.PushOverlay(newNoticeOverlay("动作层", "x"))

	// 覆盖层在时，全局键必须被吃掉——否则 Alt+j 会一边移光标一边留在面板里。
	// 覆盖层打开时全局键不该生效（交给栈顶自己处理，空壳会全部吃掉）。
	if got := Route(m, alt('j')); got != ActionOverlayKey {
		t.Fatalf("覆盖层打开时 Alt+j 应交给栈顶，实际 %v", got)
	}
	if got := Route(m, tea.KeyMsg{Type: tea.KeyEnter}); got != ActionOverlayKey {
		t.Fatalf("覆盖层打开时 Enter 不该直接发消息，实际 %v", got)
	}
	if got := Route(m, tea.KeyMsg{Type: tea.KeyEsc}); got != ActionCloseOverlay {
		t.Fatalf("Esc 应关覆盖层，实际 %v", got)
	}
}

func TestRouteGlobalKeys(t *testing.T) {
	m := testModel()
	cases := []struct {
		key  tea.KeyMsg
		want Action
	}{
		{alt('k'), ActionCursorUp},
		{alt('j'), ActionCursorDown},
		{alt('r'), ActionToggleExpand},
		{alt('y'), ActionCopy},
		{alt('o'), ActionOpenExternal},
		{alt('f'), ActionFilterFailed},
		{tea.KeyMsg{Type: tea.KeyCtrlK}, ActionCommandPalette},
		{tea.KeyMsg{Type: tea.KeyCtrlAt}, ActionActionLayer}, // Ctrl+Space 就是 NUL
		{tea.KeyMsg{Type: tea.KeyCtrlC}, ActionQuitOrInterrupt},
		{tea.KeyMsg{Type: tea.KeyEnter}, ActionSend},
		{tea.KeyMsg{Type: tea.KeyCtrlJ}, ActionNewline},
		{tea.KeyMsg{Type: tea.KeyTab}, ActionTabComplete},
		{tea.KeyMsg{Type: tea.KeyEsc}, ActionCloseOverlay},
	}
	for _, c := range cases {
		if got := Route(m, c.key); got != c.want {
			t.Fatalf("%q 路由到 %v，期望 %v", c.key.String(), got, c.want)
		}
	}
}

func TestRouteEverythingElseGoesToInput(t *testing.T) {
	m := testModel()
	for _, msg := range []tea.KeyMsg{
		runes("a"),
		runes("中"),
		tea.KeyMsg{Type: tea.KeySpace},
		tea.KeyMsg{Type: tea.KeyBackspace},
		// 未绑定的 Alt 组合也落到输入框（Alt 只是修饰位，不是模态开关）。
		alt('z'),
	} {
		if got := Route(m, msg); got != ActionInput {
			t.Fatalf("%q 应交给输入框，实际 %v", msg.String(), got)
		}
	}
}

// ── 事件归约 ────────────────────────────────────────────────────────────

func TestChunksAccumulateIntoOneLiveBlock(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindMessageChunk, Text: "he"},
		protocol.Event{Kind: protocol.KindMessageChunk, Text: "llo"},
	)
	blocks := m.VisibleBlocks()
	if len(blocks) != 1 {
		t.Fatalf("增量应落在同一块，实际 %d 块", len(blocks))
	}
	if blocks[0].Body != "hello" {
		t.Fatalf("正文拼接错：%q", blocks[0].Body)
	}
	if !blocks[0].Live {
		t.Fatal("流式中应标记 live")
	}
	if m.SessionSt != "running" {
		t.Fatalf("有增量时会话态应是 running，实际 %q", m.SessionSt)
	}
}

func TestMessageCompleteStartsNewBlock(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindMessageChunk, Text: "first"},
		protocol.Event{Kind: protocol.KindMessageComplete, Model: "k2", DurationMS: 1500},
	)
	if m.VisibleBlocks()[0].Live {
		t.Fatal("complete 之后不该还是 live")
	}
	if m.ModelID != "k2" || m.TurnDuration.Milliseconds() != 1500 {
		t.Fatalf("turn 元信息没落到 Model：model=%q dur=%v", m.ModelID, m.TurnDuration)
	}

	m = feed(m, protocol.Event{Kind: protocol.KindMessageChunk, Text: "second"})
	blocks := m.VisibleBlocks()
	if len(blocks) != 2 {
		t.Fatalf("下一段增量应是新块，实际 %d 块", len(blocks))
	}
	if blocks[1].Body != "second" {
		t.Fatalf("新块正文错：%q", blocks[1].Body)
	}
}

func TestToolBlockGetsFailedAndDuration(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindToolUseStart, ToolID: "t1", ToolName: "Bash"},
		protocol.Event{Kind: protocol.KindToolResult, ToolUseID: "t1", ToolOutput: "boom", IsError: true},
	)
	b, ok := m.Store.Get("tool:t1")
	if !ok {
		t.Fatal("工具块没建起来")
	}
	if b.Title != "Bash" {
		t.Fatalf("工具名丢了：%q", b.Title)
	}
	if !b.Failed {
		t.Fatalf("isError 应翻成 Failed：failed=%v", b.Failed)
	}
	if b.Live {
		t.Fatal("结果到了就不该还是 live")
	}
	if b.Body != "boom" {
		t.Fatalf("工具输出丢了：%q", b.Body)
	}
}

func TestToolResultWithoutStartStillCreatesBlock(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindToolResult, ToolUseID: "t9", ToolOutput: "x"},
	)
	if _, ok := m.Store.Get("tool:t9"); !ok {
		t.Fatal("只有结果的事件也要建块，不能把结果丢掉")
	}
}

func TestReplayIsIdempotent(t *testing.T) {
	ok := true
	snap := &protocol.Snapshot{ID: "3", Role: "tool", Content: "out", Name: "Read", OK: &ok}
	ev := protocol.Event{Kind: protocol.KindMessageReplay, Snapshot: snap}
	m := feed(testModel(), ev, ev, ev)

	blocks := m.VisibleBlocks()
	if len(blocks) != 1 {
		t.Fatalf("同一快照重放三次应只有一块，实际 %d 块", len(blocks))
	}
	if blocks[0].ID != "msg:3" {
		t.Fatalf("重放块 ID 应是 msg:<snapshot.id>，实际 %q", blocks[0].ID)
	}
}

func TestReplayFailureMapsToFailed(t *testing.T) {
	bad := false
	m := feed(testModel(), protocol.Event{
		Kind:     protocol.KindMessageReplay,
		Snapshot: &protocol.Snapshot{ID: "1", Role: "tool", Name: "Bash", OK: &bad},
	})
	b, _ := m.Store.Get("msg:1")
	if !b.Failed {
		t.Fatalf("ok=false 应映射成 Failed")
	}
}

func TestMessageErrorBecomesErrorBlock(t *testing.T) {
	m := feed(testModel(), protocol.Event{Kind: protocol.KindMessageError, Text: "no api key"})
	blocks := m.VisibleBlocks()
	if len(blocks) != 1 || blocks[0].Kind != store.KindError {
		t.Fatalf("错误应成 error 块，实际 %+v", blocks)
	}
	if blocks[0].Body != "no api key" {
		t.Fatalf("错误正文丢了：%q", blocks[0].Body)
	}
}

func TestCursorStaysInRange(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindMessageError, Text: "a"},
		protocol.Event{Kind: protocol.KindMessageError, Text: "b"},
	)
	m, _ = m.Update(alt('k'))
	m, _ = m.Update(alt('k'))
	m, _ = m.Update(alt('k'))
	if m.Cursor != 0 {
		t.Fatalf("光标越界：%d", m.Cursor)
	}
	for i := 0; i < 10; i++ {
		m, _ = m.Update(alt('j'))
	}
	if m.Cursor != len(m.VisibleBlocks())-1 {
		t.Fatalf("光标越界：%d / %d", m.Cursor, len(m.VisibleBlocks()))
	}
}

func TestToggleExpandOnCursorBlock(t *testing.T) {
	long := strings.Repeat("line\n", 12)
	m := feed(testModel(), protocol.Event{Kind: protocol.KindToolResult, ToolUseID: "t", ToolOutput: long})
	m, _ = m.Update(alt('r'))
	if b, _ := m.Store.Get("tool:t"); !b.Expanded {
		t.Fatal("Alt+r 没展开")
	}
	m, _ = m.Update(alt('r'))
	if b, _ := m.Store.Get("tool:t"); b.Expanded {
		t.Fatal("Alt+r 再按一次没折叠")
	}
}

// 短块折叠前后一模一样：不能静默无反应，要给一句话。
func TestToggleExpandShortBlockExplains(t *testing.T) {
	m := feed(testModel(), protocol.Event{Kind: protocol.KindToolResult, ToolUseID: "t", ToolOutput: "x"})
	m, cmd := m.Update(alt('r'))
	if b, _ := m.Store.Get("tool:t"); b.Expanded {
		t.Fatal("短块不该被标记成展开（视觉上不会有变化）")
	}
	if cmd == nil || !strings.Contains(typeName(cmd()), "notice") {
		t.Fatalf("应给一条提示，实际 %v", cmd)
	}
}

// 光标没动过时，Alt+r 作用于最新一块（此前默认第 0 块，看起来就是"没反应"）。
func TestToggleExpandTargetsLatestBlock(t *testing.T) {
	long := strings.Repeat("line\n", 12)
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindToolResult, ToolUseID: "a", ToolOutput: long},
		protocol.Event{Kind: protocol.KindToolResult, ToolUseID: "b", ToolOutput: long},
	)
	m, _ = m.Update(alt('r'))
	if first, _ := m.Store.Get("tool:a"); first.Expanded {
		t.Fatal("不该展开第一块")
	}
	if last, _ := m.Store.Get("tool:b"); !last.Expanded {
		t.Fatal("应展开最新一块")
	}
}

func TestOnlyFailedTogglesVisibility(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindMessageChunk, Text: "ok"},
		protocol.Event{Kind: protocol.KindToolResult, ToolUseID: "t", ToolOutput: "x", IsError: true},
	)
	if len(m.VisibleBlocks()) != 2 {
		t.Fatalf("默认应看到 2 块，实际 %d", len(m.VisibleBlocks()))
	}
	m, _ = m.Update(alt('f'))
	if got := len(m.VisibleBlocks()); got != 1 {
		t.Fatalf("只看失败应剩 1 块，实际 %d", got)
	}
	if m.Cursor != 0 {
		t.Fatalf("切过滤后光标应归零，实际 %d", m.Cursor)
	}
}

func TestEnterSendsOnlyWhenTextPresent(t *testing.T) {
	m := testModel()
	if _, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter}); cmd != nil {
		t.Fatal("空输入不该发消息")
	}

	m.Input.SetValue("hi")
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("有内容时 Enter 应发出 send 命令")
	}
	if m.Input.Value() != "" {
		t.Fatalf("发送后输入框应清空，实际 %q", m.Input.Value())
	}
}

func TestCtrlCInterruptsThenQuits(t *testing.T) {
	m := testModel()
	m.SessionSt = "running"

	// 跑着的时候：中断，不退出，也不武装退出（中断不是退出的一半）。
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil {
		t.Fatal("运行中 Ctrl+C 应发出 stop 命令")
	}
	if m.Quit || m.QuitArmed {
		t.Fatalf("中断不该顺带武装退出：quit=%v armed=%v", m.Quit, m.QuitArmed)
	}

	// 空转时：第一次只是示警，第二次才退。
	m.SessionSt = "idle"
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if m.Quit || !m.QuitArmed {
		t.Fatalf("第一次 Ctrl+C 应只示警：quit=%v armed=%v", m.Quit, m.QuitArmed)
	}
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if !m.Quit || cmd == nil {
		t.Fatalf("第二次 Ctrl+C 应退出：quit=%v cmd=%v", m.Quit, cmd != nil)
	}
}

func TestTabCompleteIsStub(t *testing.T) {
	m := testModel()
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyTab})
	if cmd == nil {
		t.Fatal("Tab 的桩实现应回一条提示")
	}
	if msg, ok := cmd().(noticeMsg); !ok || msg == "" {
		t.Fatalf("Tab 的桩提示为空：%v", msg)
	}
}

func TestExternalOpenWithoutSelectionNotices(t *testing.T) {
	m := testModel() // 没有块 → 没有选中项
	_, cmd := m.Update(alt('o'))
	if cmd == nil {
		t.Fatal("没有选中块时应回一条提示")
	}
	if msg, ok := cmd().(noticeMsg); !ok || msg == "" {
		t.Fatalf("提示为空：%v", msg)
	}
}

func TestPanelsPushOverlayShells(t *testing.T) {
	m := testModel()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	if _, ok := m.TopOverlay(); !ok {
		t.Fatal("Ctrl+K 应压入命令面板壳")
	}
	// 覆盖层打开时全局键被吃掉，先关掉再验证下一个面板。
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if _, ok := m.TopOverlay(); ok {
		t.Fatal("Esc 应关掉命令面板")
	}

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlAt})
	if ov, ok := m.TopOverlay(); !ok || ov.Title() != "动作层" {
		t.Fatalf("Ctrl+Space 应压入动作层壳，实际 %v", ov)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if _, ok := m.TopOverlay(); ok {
		t.Fatal("Esc 应弹空覆盖层栈")
	}
}

func TestViewIsPureAndFitsHeight(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindMessageChunk, Text: "hello"},
	)
	before := m.Store.List()[0].Version
	first := m.View()
	second := m.View()
	if first != second {
		t.Fatal("View 两次输出不同——说明 View 有副作用")
	}
	if after := m.Store.List()[0].Version; after != before {
		t.Fatalf("View 改了状态：version %d → %d", before, after)
	}
	if !containsAll(first, "zhishi", "hello", "Alt+j/k") {
		t.Fatalf("视图缺少必要元素：\n%s", first)
	}
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}

// 折叠提示挂在助手长正文上、后面又跟了一条短工具结果时，Alt+r 必须落在
// **有内容的**那块上——落在最后那条短块上等于没反应。
func TestToggleExpandSkipsShortTailBlocks(t *testing.T) {
	long := strings.Repeat("line\n", 12)
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindToolResult, ToolUseID: "a", ToolOutput: long},
		protocol.Event{Kind: protocol.KindToolResult, ToolUseID: "b", ToolOutput: "ok"},
	)
	if got := m.effectiveCursor(); got != 0 {
		t.Fatalf("默认目标应是最后一块可折叠的块（下标 0），实际 %d", got)
	}
	m, _ = m.Update(alt('r'))
	if b, _ := m.Store.Get("tool:a"); !b.Expanded {
		t.Fatal("应展开长块")
	}
	if b, _ := m.Store.Get("tool:b"); b.Expanded {
		t.Fatal("短块不该被碰")
	}
}

// 工具调用前后必须分成两个助手块：sidecar 一个 turn 只在最后发
// message-complete，中间没有分界；不主动封段的话，工具之后的总结会被追加
// 到工具**之前**那块里，屏幕上就是"总结跑到工具输出上面去了"。
func TestAssistantSegmentsSplitAroundToolCalls(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindMessageChunk, Text: "我先扫端口。"},
		protocol.Event{Kind: protocol.KindToolUseStart, ToolID: "t1", ToolName: "Bash"},
		protocol.Event{Kind: protocol.KindToolResult, ToolUseID: "t1", ToolOutput: "22/tcp open ssh"},
		protocol.Event{Kind: protocol.KindMessageChunk, Text: "总结：ssh 超时。"},
		protocol.Event{Kind: protocol.KindMessageComplete, Model: "x"},
	)
	blocks := m.Store.List()
	if len(blocks) != 3 {
		t.Fatalf("应为 助手/工具/助手 三块，实际 %d：%+v", len(blocks), blocks)
	}
	if blocks[0].Kind != store.KindAssistant || blocks[0].Body != "我先扫端口。" {
		t.Fatalf("第一块应是工具前的助手段，实际 %+v", blocks[0])
	}
	if blocks[1].Kind != store.KindTool {
		t.Fatalf("第二块应是工具，实际 %+v", blocks[1])
	}
	if blocks[2].Kind != store.KindAssistant || !strings.Contains(blocks[2].Body, "总结") {
		t.Fatalf("最后一块应是总结（在工具之后），实际 %+v", blocks[2])
	}
}

// env_exec 的正文首行是 `exit=N`：非 0 必须在块头上标 ✗，否则 exit=1 的块
// 挂着绿勾，极易看漏。
func TestEnvExecNonZeroExitMarksFailed(t *testing.T) {
	cases := map[string]bool{
		"exit=0\n--- stdout ---\nok": false,
		"exit=1\n--- stdout ---\nno": true,
		"exit=123\n--- stdout ---\n": true,
		"plain output without exit":  false,
		"noise\nexit=1":              false, // 只认首行
	}
	for out, wantFailed := range cases {
		m := feed(testModel(), protocol.Event{
			Kind: protocol.KindToolResult, ToolUseID: "t", ToolOutput: out,
		})
		b, _ := m.Store.Get("tool:t")
		if b.Failed != wantFailed {
			t.Fatalf("%q: Failed=%v，期望 %v", out, b.Failed, wantFailed)
		}
	}
}

// 只调工具、没说话的助手消息（content 为空）不该长出空块头。
func TestReplaySkipsEmptyAssistantMessage(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindMessageReplay, Snapshot: &protocol.Snapshot{ID: "1", Role: "assistant", Content: "   "}},
		protocol.Event{Kind: protocol.KindMessageReplay, Snapshot: &protocol.Snapshot{ID: "2", Role: "assistant", Content: "有内容"}},
	)
	blocks := m.Store.List()
	if len(blocks) != 1 || blocks[0].ID != "msg:2" {
		t.Fatalf("空助手消息应被跳过，实际 %+v", blocks)
	}
}

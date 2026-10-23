package app

import (
	"fmt"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/protocol"
)

// 默认把鼠标留给终端：原生拖选开箱即用；滚轮靠 ↑↓ 兜底。
func TestMouseReleasedByDefault(t *testing.T) {
	m := testModel()
	if m.MouseOn {
		t.Fatal("默认不该接管鼠标，否则终端拖选失效")
	}
	if strings.Contains(m.statusLine(), "鼠标") {
		t.Fatalf("默认不该有鼠标徽记：%s", m.statusLine())
	}
}

func TestMouseToggleReleasesAndRecaptures(t *testing.T) {
	m := testModel()

	m, cmd := m.Update(alt('m'))
	if !m.MouseOn {
		t.Fatal("Alt+m 应接管鼠标")
	}
	if cmd == nil || typeName(cmd()) != "enableMouseCellMotionMsg" {
		t.Fatalf("应下发 enableMouseCellMotionMsg，实际 %v", cmd)
	}

	if !strings.Contains(m.statusLine(), "鼠标") {
		t.Fatalf("接管时状态行应有「鼠标」徽记：%s", m.statusLine())
	}
	m, cmd = m.Update(alt('m'))
	if m.MouseOn {
		t.Fatal("再按一次应释放鼠标")
	}
	if cmd == nil || typeName(cmd()) != "disableMouseMsg" {
		t.Fatalf("释放时应下发 disableMouseMsg，实际 %v", cmd)
	}
	if strings.Contains(m.statusLine(), "鼠标") {
		t.Fatalf("交还后不该有鼠标徽记：%s", m.statusLine())
	}
}

// 中文输入法开着时 Alt+字母偶尔收不到，F2 是同一动作的备用键。
func TestF2AlsoTogglesMouse(t *testing.T) {
	m := testModel()
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyF2})
	if !m.MouseOn || cmd == nil {
		t.Fatalf("F2 应接管鼠标并下发命令，实际 mouseOn=%v cmd=%v", m.MouseOn, cmd)
	}
}

// 鼠标释放后，终端可能把滚轮翻译成 ↑↓——输入框空着时借给 stream 滚动。
func TestArrowKeysScrollWhenMouseReleased(t *testing.T) {
	m := testModel()
	for i := 0; i < 40; i++ {
		m = feed(m, toolEventFor(i))
	}
	m.MouseOn = false
	before := m.ScrollLines
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp})
	if m.ScrollLines <= before {
		t.Fatalf("↑ 应向上滚动，实际 %d → %d", before, m.ScrollLines)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	if m.ScrollLines >= before+3 {
		t.Fatalf("↓ 应向下滚回，实际 %d", m.ScrollLines)
	}
}

func toolEventFor(i int) protocol.Event {
	return protocol.Event{
		Kind:       protocol.KindToolResult,
		ToolUseID:  fmt.Sprintf("t%d", i),
		ToolOutput: "exit=0\n" + strings.Repeat("output line\n", 8),
	}
}

// 光标移出视口时必须自动滚动，否则往上翻十几下屏幕不动，等于瞎选。
func TestCursorMoveScrollsViewport(t *testing.T) {
	m := testModel() // 100x30
	for i := 0; i < 30; i++ {
		m = feed(m, toolEventFor(i))
	}
	m.layout()
	if m.ScrollLines != 0 {
		t.Fatalf("初始应贴底，实际 %d", m.ScrollLines)
	}
	for i := 0; i < 15; i++ {
		m, _ = m.Update(alt('k'))
	}
	if m.ScrollLines == 0 {
		t.Fatal("光标移到视口外后 ScrollLines 应变化")
	}
	target, ok := m.CursorBlock()
	if !ok {
		t.Fatal("应能取到光标块")
	}
	m.View() // 生成帧投影
	visible := false
	for _, row := range m.Frame.rows {
		if row.ID == target.ID {
			visible = true
			break
		}
	}
	if !visible {
		t.Fatalf("光标块 %s 不在可见区域内（ScrollLines=%d）", target.ID, m.ScrollLines)
	}
}

// 终端原生拖选被鼠标上报挡住，所以应用层自己算选中范围：拖动 → 松开即复制。
func TestDragSelectsAndCopies(t *testing.T) {
	m := testModel()
	m = feed(m, protocol.Event{Kind: protocol.KindMessageChunk, Text: "hello world"})
	m.View() // 建帧

	row := -1
	for i, l := range m.Frame.lines {
		if strings.Contains(stripANSI(l), "hello") {
			row = i
			break
		}
	}
	if row < 0 {
		t.Fatalf("帧里找不到正文行：%+v", m.Frame.lines)
	}
	y := row + m.Frame.streamTop

	m, _ = m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: 2, Y: y})
	m, _ = m.Update(tea.MouseMsg{Action: tea.MouseActionMotion, Button: tea.MouseButtonLeft, X: 9, Y: y})
	if got := m.selectedText(); !strings.Contains(got, "hello") {
		t.Fatalf("拖选文本不对：%q", got)
	}
	// bubbletea 的 release 事件 Button 是 None——测试照实模拟，否则会漏掉这个 bug。
	m, cmd := m.Update(tea.MouseMsg{Action: tea.MouseActionRelease, Button: tea.MouseButtonNone, X: 9, Y: y})
	if cmd == nil {
		t.Fatal("松开后应发出复制命令")
	}
	if !strings.Contains(m.LastNotice, "已复制") {
		t.Fatalf("应提示已复制，实际 %q", m.LastNotice)
	}
	if m.Sel.active || m.Sel.down {
		t.Fatal("手势结束后选中状态应复位")
	}
}

// 只按下不拖 = 点击，不该复制（否则每次点块头都会顺手覆盖剪贴板）。
func TestClickWithoutDragDoesNotCopy(t *testing.T) {
	m := testModel()
	m = feed(m, protocol.Event{Kind: protocol.KindMessageChunk, Text: "hello world"})
	m.View()
	row := 0
	for i, l := range m.Frame.lines {
		if strings.Contains(stripANSI(l), "hello") {
			row = i
			break
		}
	}
	y := row + m.Frame.streamTop
	m, _ = m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: 2, Y: y})
	m, cmd := m.Update(tea.MouseMsg{Action: tea.MouseActionRelease, Button: tea.MouseButtonNone, X: 2, Y: y})
	if cmd != nil {
		t.Fatal("未拖动不该复制")
	}
}

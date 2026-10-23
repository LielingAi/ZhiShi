package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/protocol"
)

// 内容不足一屏时按 ↑ 不该滚动——以前上界算不出来，按一下就切掉底部几行。
func TestShortContentDoesNotScroll(t *testing.T) {
	m := testModel() // 100x30
	m = feed(m,
		protocol.Event{Kind: protocol.KindMessageChunk, Text: "第一段"},
		protocol.Event{Kind: protocol.KindMessageComplete, Model: "x"},
		protocol.Event{Kind: protocol.KindToolUseStart, ToolID: "t1", ToolName: "Bash"},
		protocol.Event{Kind: protocol.KindToolResult, ToolUseID: "t1", ToolOutput: "exit=0\nline"},
	)
	m.View()
	before := m.View()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp})
	if m.ScrollLines != 0 {
		t.Fatalf("内容不足一屏不该滚动，实际 %d", m.ScrollLines)
	}
	if after := m.View(); after != before {
		t.Fatalf("画面不该变化：\n前：\n%s\n后：\n%s", before, after)
	}
	if !strings.Contains(m.View(), "line") {
		t.Fatal("底部内容不该被切掉")
	}
}

// 长内容滚到顶后，再按 ↑ 应停在上界（不能无限加）。
func TestScrollClampsAtTop(t *testing.T) {
	m := testModel()
	for i := 0; i < 40; i++ {
		m = feed(m, toolEventFor(i))
	}
	m.View()
	for i := 0; i < 200; i++ {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp})
	}
	max := m.maxScrollLines()
	if m.ScrollLines != max {
		t.Fatalf("应停在上界 %d，实际 %d", max, m.ScrollLines)
	}
}

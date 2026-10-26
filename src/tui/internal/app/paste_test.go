package app

import (
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func TestPasteMultiLine(t *testing.T) {
	m := testModel()
	msg := tea.KeyMsg{Type: tea.KeyRunes, Paste: true, Runes: []rune("line1\nline2\nline3")}
	m, _ = m.Update(msg)
	if got := m.Input.Value(); got != "line1\nline2\nline3" {
		t.Fatalf("多行粘贴应完整进输入框，实际 %q", got)
	}
}

func TestPasteCRLFNormalized(t *testing.T) {
	m := testModel()
	msg := tea.KeyMsg{Type: tea.KeyRunes, Paste: true, Runes: []rune("line1\r\nline2\rline3")}
	m, _ = m.Update(msg)
	if got := m.Input.Value(); got != "line1\nline2\nline3" {
		t.Fatalf("CRLF/CR 应归一为单个换行，实际 %q", got)
	}
}

// conhost 无 bracketed paste：粘贴被拆成逐字符 + 回车注入。
func TestPasteEnterInsertsNewlineInsteadOfSending(t *testing.T) {
	m := testModel()
	fixed := time.Unix(1000, 0)
	m.Clock = func() time.Time { return fixed }
	m.FastChars = 20
	m.LastKeyAt = fixed
	m.Input.SetValue("line1")

	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatal("粘贴过程中的回车不应触发发送")
	}
	if got := m.Input.Value(); got != "line1\n" {
		t.Fatalf("应插入换行，实际 %q", got)
	}
	// 连续空行（粘贴里的空行）同样不能发送。
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatal("粘贴中的空行不应触发发送")
	}
	if got := m.Input.Value(); got != "line1\n\n" {
		t.Fatalf("空行应保留为第二个换行，实际 %q", got)
	}
}

func TestNormalEnterStillSends(t *testing.T) {
	m := testModel()
	m.Input.SetValue("hello")
	m.FastChars = 0
	m.LastKeyAt = time.Time{}
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("正常回车应发送")
	}
}

package app

import (
	"testing"

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

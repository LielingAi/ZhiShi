package app

import (
	"strings"
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

func TestLargePasteOverflowsInsteadOfTruncating(t *testing.T) {
	m := testModel()
	var b strings.Builder
	for i := 0; i < 12000; i++ {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString("line")
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Paste: true, Runes: []rune(b.String())})

	if len(m.PasteOverflow) == 0 {
		t.Fatal("超过输入框上限的粘贴应进入 PasteOverflow")
	}
	if got := len(strings.Split(m.composeInput(), "\n")); got != 12000 {
		t.Fatalf("发送文本应保留全部 12000 行，实际 %d", got)
	}
	if m.Input.LineCount() > inputLineCap+1 {
		t.Fatalf("输入框内容不应超过软上限，实际 %d", m.Input.LineCount())
	}
	if line := m.statusLine(); !strings.Contains(line, "暂存") {
		t.Fatalf("状态行应提示暂存行数：%q", line)
	}
}

package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
)

// 2.2.1 — 档案默认展示简报（三块），f 切完整账本。
func TestArchiveBriefIsDefaultAndToggle(t *testing.T) {
	m := testModel()
	m.PushOverlay(newArchiveOverlay())
	ov, ok := lastOverlayOf[*archiveOverlay](&m)
	if !ok {
		t.Fatal("档案面板未压入")
	}
	ov.apply(
		[]archiveGroup{{kind: "finding", rows: []row{{Key: "C#1", Desc: "登录口 SQL 注入"}}}},
		nil,
		nil,
		&client.ArchiveBrief{
			Solid:  []client.ArchiveBriefItem{{ID: "C#1", Kind: "finding", Text: "登录口 SQL 注入可读会话", Status: "established", Support: 1}},
			Gaps:   []client.ArchiveBriefItem{{ID: "Q#1", Kind: "question", Text: "WAF 怎么绕？", Status: "open", Reason: "未决问题"}},
			Closed: []client.ArchiveBriefItem{{ID: "H#1", Kind: "hypothesis", Text: "路径穿越", Status: "falsified", Reason: "输入已规范化"}},
		},
	)

	out := m.View()
	for _, want := range []string{"研究档案 · 简报", "靠得住的结论", "还缺什么", "已经死了", "证据 1", "输入已规范化"} {
		if !strings.Contains(out, want) {
			t.Fatalf("简报缺少 %q：\n%s", want, out)
		}
	}

	// f：切完整账本，能回到实体列表与写操作提示。
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'f'}})
	out = m.View()
	if !strings.Contains(out, "f 看简报") || !strings.Contains(out, "C#1") {
		t.Fatalf("f 应切到完整账本：\n%s", out)
	}
}

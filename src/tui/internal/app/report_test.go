package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
)

// 导出报告：workspace 未知时置灰并说明原因；可用时发命令并用回收执落块。
func TestReportExportFromSessionPanel(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{reportInfo: client.ReportExportInfo{
		ReportDir: "/ws/output/report-1", EvidenceCount: 3, Sanitized: true,
		Degraded: []string{"evidence 404"},
	}}
	m.Workspace = "/ws"
	m.PushOverlay(newSessionOverlay(&m))
	ov, _ := lastOverlayOf[*sessionOverlay](&m)
	if !ov.items[len(ov.items)-1].enabled {
		t.Fatal("有 workspace 时应启用导出")
	}
	for i := 0; i < len(ov.items)-1; i++ {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("应发出导出命令")
	}
	msg := cmd().(reportExportDoneMsg)
	if msg.err != nil {
		t.Fatalf("导出命令不该失败：%v", msg.err)
	}
	m, _ = m.Update(msg)
	if !strings.Contains(m.LastNotice, "报告已生成") {
		t.Fatalf("应提示生成位置，实际 %q", m.LastNotice)
	}
	// 回执落成一个块，含降级项
	found := false
	for _, b := range m.Store.List() {
		if strings.Contains(b.Body, "目录:") {
			found = true
			if !strings.Contains(b.Body, "evidence 404") {
				t.Fatalf("降级项应写进块：%q", b.Body)
			}
		}
	}
	if !found {
		t.Fatal("应生成报告回执块")
	}
}

func TestReportExportDisabledWithoutWorkspace(t *testing.T) {
	m := testModel()
	m.PushOverlay(newSessionOverlay(&m))
	ov, _ := lastOverlayOf[*sessionOverlay](&m)
	last := ov.items[len(ov.items)-1]
	if last.enabled {
		t.Fatal("没有 workspace 时不该启用导出")
	}
	if !strings.Contains(last.hint, "workspace") {
		t.Fatalf("应说明原因，实际 %q", last.hint)
	}
}

// 导出是长操作：按下去必须有"正在导出"的反馈，否则像没反应。
func TestReportExportShowsProgress(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{}
	m.Workspace = "/ws"
	m.PushOverlay(newSessionOverlay(&m))
	for i := 0; i < 5; i++ {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("应发出导出命令")
	}
	if !strings.Contains(m.LastNotice, "正在导出") {
		t.Fatalf("应提示导出进行中，实际 %q", m.LastNotice)
	}
}

package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
)

func TestAtToken(t *testing.T) {
	cases := map[string]bool{
		"看下 @app/Http":    true,
		"@src":            true,
		"a@b.com":         false, // 邮箱不触发
		"没有 at":           false,
		"@app/Http 后面有空格": false, // token 已结束
	}
	for in, want := range cases {
		_, _, ok := atToken(in)
		if ok != want {
			t.Fatalf("%q: ok=%v，期望 %v", in, ok, want)
		}
	}
}

func TestAtMenuFiltersAndApplies(t *testing.T) {
	m := testModel()
	m.AtFiles = []client.WorkspaceFile{
		{Path: "app/Http/Controllers/EmailController.php", Type: "file"},
		{Path: "app/Mail/PeeringManager.php", Type: "file"},
		{Path: "config", Type: "dir"},
	}
	m.AtLoaded = true
	for _, r := range "看看 @app/Mail" {
		m, _ = m.Update(runes(string(r)))
	}
	if m.AtRows() == 0 {
		t.Fatalf("应弹出 @ 候选（input=%q）", m.Input.Value())
	}
	if got := m.At.items[0].path; !strings.Contains(got, "PeeringManager") {
		t.Fatalf("应过滤到 app/Mail 下的文件，实际 %q", got)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyTab})
	if got := m.Input.Value(); !strings.Contains(got, "@app/Mail/PeeringManager.php ") {
		t.Fatalf("Tab 应补全路径，实际 %q", got)
	}
	if m.AtRows() != 0 {
		t.Fatal("补全后候选应收起")
	}
}

func TestAtEnterCompletesInsteadOfSending(t *testing.T) {
	m := testModel()
	m.AtFiles = []client.WorkspaceFile{{Path: "a/b.go", Type: "file"}}
	m.AtLoaded = true
	for _, r := range "@a/" {
		m, _ = m.Update(runes(string(r)))
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatal("Enter 应接受补全，不该发送")
	}
	if got := m.Input.Value(); !strings.Contains(got, "@a/b.go") {
		t.Fatalf("应补全为 @a/b.go，实际 %q", got)
	}
}

// @token → 结构化 refs：只有与已知文件精确匹配、或 env:<id> 才发，其余忽略。
func TestExtractRefs(t *testing.T) {
	m := testModel()
	m.AtFiles = []client.WorkspaceFile{{Path: "app/Mail/x.php", Type: "file"}}
	refs := m.extractRefs("看 @app/Mail/x.php 和 @env:vsrx3-133，别管 a@b.com 和 @nope")
	if len(refs) != 2 {
		t.Fatalf("应提取 2 条 refs，实际 %d：%+v", len(refs), refs)
	}
	if refs[0].Type != "file" || refs[0].Path != "app/Mail/x.php" {
		t.Fatalf("文件 ref 不对：%+v", refs[0])
	}
	if refs[1].Type != "env" || refs[1].ID != "vsrx3-133" {
		t.Fatalf("环境 ref 不对：%+v", refs[1])
	}
	// 重复只发一次
	if got := m.extractRefs("@app/Mail/x.php @app/Mail/x.php"); len(got) != 1 {
		t.Fatalf("重复应去重，实际 %+v", got)
	}
}

// 权限模式切换会写进下一条消息的 payload。
func TestPermissionModeToggle(t *testing.T) {
	m := testModel()
	if m.PermissionMode != "auto" {
		t.Fatalf("默认应是 auto，实际 %q", m.PermissionMode)
	}
	m.PushOverlay(newSessionOverlay(&m))
	// 选到"权限模式"（最后一项）
	for i := 0; i < 4; i++ {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.PermissionMode != "fullAgency" {
		t.Fatalf("应切到 fullAgency，实际 %q", m.PermissionMode)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.PermissionMode != "auto" {
		t.Fatalf("再切回应是 auto，实际 %q", m.PermissionMode)
	}
}

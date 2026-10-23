package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
)

func envOverlayWith(m Model, rows ...row) Model {
	ov := newEnvOverlay()
	ov.setRows(rows)
	m.PushOverlay(ov)
	return m
}

func TestEnvDownAndRmNeedConfirmation(t *testing.T) {
	m := envOverlayWith(testModel(), row{Key: "vsrx", Title: "vsrx", Desc: "vm"})
	m.Admin = &fakeAdmin{}

	m, cmd := m.Update(runes("d"))
	if cmd == nil {
		t.Fatal("d 应停止选中环境")
	}
	if msg := cmd().(envOpDoneMsg); msg.op != "down" || msg.id != "vsrx" {
		t.Fatalf("停止消息不对：%+v", msg)
	}

	// x 第一次只提示
	m, cmd = m.Update(runes("x"))
	if cmd != nil {
		t.Fatal("第一次 x 不该删除")
	}
	ov, _ := lastOverlayOf[*envOverlay](&m)
	if !strings.Contains(ov.note, "再按一次") {
		t.Fatalf("应提示二次确认，实际 %q", ov.note)
	}
	m, cmd = m.Update(runes("x"))
	if cmd == nil {
		t.Fatal("第二次 x 应删除")
	}
	if msg := cmd().(envOpDoneMsg); msg.op != "rm" {
		t.Fatalf("应为 rm，实际 %s", msg.op)
	}
}

func TestEnvRenamePrompt(t *testing.T) {
	m := envOverlayWith(testModel(), row{Key: "vsrx", Title: "vsrx"})
	m.Admin = &fakeAdmin{}
	m, _ = m.Update(runes("n"))
	ov, ok := m.TopOverlay()
	if !ok {
		t.Fatal("n 应弹出重命名输入框")
	}
	if _, isPrompt := ov.(*promptOverlay); !isPrompt {
		t.Fatalf("栈顶应是输入框，实际 %T", ov)
	}
	for _, r := range "新名字" {
		m, _ = m.Update(runes(string(r)))
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("Enter 应发出重命名命令")
	}
	if msg := cmd().(envOpDoneMsg); !strings.Contains(msg.id, "vsrx") {
		t.Fatalf("重命名 id 不对：%+v", msg)
	}
}

func TestEnvRecipesOverlay(t *testing.T) {
	m := envOverlayWith(testModel(), row{Key: "vsrx", Title: "vsrx"})
	m.Admin = &fakeAdmin{recipes: []client.EnvRecipe{{ID: "pentest", Name: "渗透", Description: "kali"}}}
	m, cmd := m.Update(runes("l"))
	if cmd == nil {
		t.Fatal("l 应加载配方清单")
	}
	m, _ = m.Update(cmd())
	out := m.View()
	if !strings.Contains(out, "渗透") || !strings.Contains(out, "kali") {
		t.Fatalf("配方清单应显示名称与描述：\n%s", out)
	}
}

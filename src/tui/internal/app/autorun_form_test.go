package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func fillForm(t *testing.T, m Model, values ...string) Model {
	t.Helper()
	ov, ok := lastOverlayOf[*autoRunForm](&m)
	if !ok {
		t.Fatal("表单未打开")
	}
	// values 依次是 name/goal/env/limit/criteria；空串跳过
	for i, v := range values {
		if v == "" {
			continue
		}
		ov.focus = i
		for _, r := range v {
			m, _ = m.Update(runes(string(r)))
		}
	}
	return m
}

func TestAutoRunFormValidatesAndStarts(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{}
	m.EnvironmentID = "vsrx"
	m, _ = m.Update(alt('w')) // 打开观察面（会顺带刷新，命令忽略）
	m, _ = m.Update(runes("n"))
	if _, ok := lastOverlayOf[*autoRunForm](&m); !ok {
		t.Fatal("n 应打开启动表单")
	}

	// 空表单直接 Enter → 提示任务名必填，不发命令
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatal("空表单不该启动")
	}
	ov, _ := lastOverlayOf[*autoRunForm](&m)
	if !strings.Contains(ov.note, "任务名") {
		t.Fatalf("应提示任务名必填，实际 %q", ov.note)
	}

	m = fillForm(t, m, "打穿 133", "拿 shell", "vsrx", "20", "拿到 user.txt; 拿到 root.txt")
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("填全后应启动")
	}
	msg := cmd().(autoRunStartDoneMsg)
	if msg.err != nil {
		t.Fatalf("启动命令失败：%v", msg.err)
	}
	m, _ = m.Update(msg)
	if !strings.Contains(m.LastNotice, "run-1") {
		t.Fatalf("应提示 run id，实际 %q", m.LastNotice)
	}
}

func TestAutoRunFormBudgetCycles(t *testing.T) {
	m := testModel()
	m.PushOverlay(newAutoRunForm(&m))
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRight})
	ov, _ := lastOverlayOf[*autoRunForm](&m)
	if ov.budget != 1 {
		t.Fatalf("→ 应切到 tokens，实际 %d", ov.budget)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyLeft})
	ov, _ = lastOverlayOf[*autoRunForm](&m)
	if ov.budget != 0 {
		t.Fatalf("← 应切回 turns，实际 %d", ov.budget)
	}
}

func TestAutoRunFormCriteriaSplit(t *testing.T) {
	got := splitCriteria(" 甲 ; 乙；丙 ;; ")
	if len(got) != 3 || got[0] != "甲" || got[2] != "丙" {
		t.Fatalf("分号切分不对：%+v", got)
	}
}

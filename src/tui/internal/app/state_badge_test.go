package app

import (
	"strings"
	"testing"
	"time"
)

// 2.2.4 — 空闲/运行必须一眼可见：header 徽标 + 状态行 + 输入框边框。
func TestRunningStateIsVisible(t *testing.T) {
	m := testModel()
	m.SessionSt = "idle"
	m.Connected = true
	if out := m.View(); !strings.Contains(out, "○ 空闲") {
		t.Fatalf("空闲态应有「○ 空闲」徽标：\n%s", out)
	}

	m.SessionSt = "running"
	m.TaskStarted = time.Now().Add(-5 * time.Second)
	m.Now = time.Now()
	out := m.View()
	if !strings.Contains(out, "● 运行中") {
		t.Fatalf("运行态 header 应有「● 运行中」：\n%s", out)
	}
	if !strings.Contains(m.statusLine(), "● 运行中") {
		t.Fatalf("状态行也应显示运行态：%q", m.statusLine())
	}
}

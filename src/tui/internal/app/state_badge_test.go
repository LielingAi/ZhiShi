package app

import (
	"strings"
	"testing"
	"time"
)

// 2.2.5 — 状态只在状态行/输入框边框显示，header 不再重复徽标。
func TestRunningStateIsVisible(t *testing.T) {
	m := testModel()
	m.SessionSt = "idle"
	m.Connected = true
	out := m.View()
	if strings.Contains(out, "○ 空闲") {
		t.Fatalf("header 不应再显示空闲徽标：\n%s", out)
	}

	m.SessionSt = "running"
	m.TaskStarted = time.Now().Add(-5 * time.Second)
	m.Now = time.Now()
	if line := m.statusLine(); !strings.Contains(line, "● 运行中") {
		t.Fatalf("状态行应显示运行态：%q", line)
	}
	if out := m.View(); strings.Contains(out, "● 运行中 5s") && strings.Count(out, "● 运行中") > 1 {
		t.Fatalf("运行态不应在多个位置重复出现：\n%s", out)
	}
}

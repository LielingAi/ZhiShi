package app

import (
	"strings"
	"testing"

	"github.com/lielingai/zhishi/tui/internal/client"
	"github.com/lielingai/zhishi/tui/internal/protocol"
)

func TestAutoRunEventsUpdateState(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindAutoRunStarted, AutoRunID: "r1", Name: "打穿 133",
			EnvKey: "vsrx", Goal: "拿 shell", BudgetKind: "turns", BudgetLimit: 100},
	)
	if m.AutoRun == nil || m.AutoRun.ID != "r1" || !m.AutoRunActive() {
		t.Fatalf("started 应建立运行态：%+v", m.AutoRun)
	}
	if !strings.Contains(m.statusLine(), "⛁") {
		t.Fatalf("运行中状态行应有 auto-run 标记：%s", m.statusLine())
	}
	m = feed(m,
		protocol.Event{Kind: protocol.KindAutoRunPhase, AutoRunID: "r1", Phase: "exploit", PrevPhase: "recon"},
		protocol.Event{Kind: protocol.KindAutoRunTurn, AutoRunID: "r1", Turn: 7, Phase: "exploit",
			Status: "running", BudgetKind: "turns", BudgetLimit: 100, BudgetSpent: 7},
	)
	if m.AutoRun.Phase != "exploit" || m.AutoRun.Turns != 7 || m.AutoRun.Budget.Spent != 7 {
		t.Fatalf("phase/turn 未落库：%+v", m.AutoRun)
	}
	m = feed(m, protocol.Event{Kind: protocol.KindAutoRunCompleted, AutoRunID: "r1", Outcome: "passed"})
	if m.AutoRunActive() {
		t.Fatal("completed 后不该还算活跃")
	}
	if !strings.Contains(m.LastNotice, "passed") {
		t.Fatalf("结束提示缺失：%q", m.LastNotice)
	}
}

func TestAutoRunOverlayShowsAndStops(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{}
	m = feed(m, protocol.Event{Kind: protocol.KindAutoRunStarted, AutoRunID: "r1",
		Name: "打穿 133", EnvKey: "vsrx", Goal: "拿 shell", BudgetKind: "turns", BudgetLimit: 100})
	m, cmd := m.Update(alt('w'))
	if cmd == nil {
		t.Fatal("Alt+w 应同时发刷新命令")
	}
	out := m.View()
	for _, want := range []string{"打穿 133", "vsrx", "100"} {
		if !strings.Contains(out, want) {
			t.Fatalf("面板应显示 %q：\n%s", want, out)
		}
	}
	m, cmd = m.Update(runes("x"))
	if cmd == nil {
		t.Fatal("x 应发终止命令")
	}
	if msg := cmd().(autoRunStopDoneMsg); msg.id != "r1" {
		t.Fatalf("终止 id 不对：%+v", msg)
	}
	m, _ = m.Update(autoRunStopDoneMsg{id: "r1"})
	if m.AutoRun.Status != "stopped" {
		t.Fatalf("本地状态应转 stopped，实际 %q", m.AutoRun.Status)
	}
}

func TestAutoRunOverlayRefreshesFromServer(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{autoRun: client.AutoRunInfo{ID: "r1", Name: "x", Status: "running", Turns: 3}}
	m.PushOverlay(newAutoRunOverlay())
	m, cmd := m.Update(autoRunRefreshedMsg{record: &client.AutoRunInfo{ID: "r1", Name: "x", Status: "running", Turns: 3}})
	_ = cmd
	if m.AutoRun == nil || m.AutoRun.Turns != 3 {
		t.Fatalf("刷新应写回状态：%+v", m.AutoRun)
	}
}

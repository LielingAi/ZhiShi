package app

import (
	"strings"
	"testing"

	"github.com/lielingai/zhishi/tui/internal/protocol"
)

// busy 时发消息 = 纠偏注入（steering），不是 FIFO 排队：界面必须有反馈，
// 否则用户会以为消息丢了。
func TestSteeringEventsTrackQueue(t *testing.T) {
	m := feed(testModel(), protocol.Event{Kind: protocol.KindSteeringAdded, QueueID: "q1", Text: "换个思路"})
	if m.QueuedCount() != 1 {
		t.Fatalf("纠偏应计入队列深度，实际 %d", m.QueuedCount())
	}
	if !strings.Contains(m.LastNotice, "纠偏") {
		t.Fatalf("应有纠偏提示，实际 %q", m.LastNotice)
	}
	m = feed(m, protocol.Event{Kind: protocol.KindSteeringCancelled, QueueID: "q1"})
	if m.QueuedCount() != 0 {
		t.Fatalf("取消后队列应回落，实际 %d", m.QueuedCount())
	}
}

// 后台进程生命周期：之前完全没有反馈，用户以为 env_bg 没跑。
func TestBgLifecycleTracked(t *testing.T) {
	m := feed(testModel(), protocol.Event{Kind: protocol.KindBgStarted, Tag: "scan", PID: 4242, Text: "nmap -sV"})
	if len(m.Bg) != 1 {
		t.Fatalf("应登记 1 个后台任务，实际 %d", len(m.Bg))
	}
	if !strings.Contains(m.LastNotice, "scan") {
		t.Fatalf("启动提示应含 tag，实际 %q", m.LastNotice)
	}
	if !strings.Contains(m.statusLine(), "后台 1") {
		t.Fatalf("状态行应显示后台数：%s", m.statusLine())
	}
	m = feed(m, protocol.Event{Kind: protocol.KindBgFinished, Tag: "scan", Status: "exited", ExitCode: 0})
	if len(m.Bg) != 0 {
		t.Fatalf("结束后应清掉，实际 %d", len(m.Bg))
	}
	if !strings.Contains(m.LastNotice, "结束") {
		t.Fatalf("结束提示缺失：%q", m.LastNotice)
	}
}

// 会话标题 / 任务形态：常量早就存在，但之前既不解析也不显示。
func TestSessionTitleAndMission(t *testing.T) {
	m := feed(testModel(),
		protocol.Event{Kind: protocol.KindSessionTitle, Title: "扫描 192.168.88.133"},
		protocol.Event{Kind: protocol.KindMission, Mission: "discover", Text: "挖掘"},
	)
	if m.SessionTitle != "扫描 192.168.88.133" {
		t.Fatalf("标题未落库：%q", m.SessionTitle)
	}
	if m.Mission != "挖掘" {
		t.Fatalf("mission 未落库：%q", m.Mission)
	}
	out := m.View()
	if !strings.Contains(out, "扫描 192.168.88.133") {
		t.Fatalf("标题应出现在标题行：\n%s", out)
	}
	if !strings.Contains(out, "挖掘") {
		t.Fatalf("mission 应出现在状态行：\n%s", out)
	}
}

// archive:changed 时若档案面板开着，应自动重载（否则一直显示旧树）。
func TestArchiveChangedRefreshesOpenPanel(t *testing.T) {
	m := testModel()
	m.PushOverlay(newArchiveOverlay())
	m2, _ := m.Update(EventMsg(protocol.Event{Kind: protocol.KindArchiveChanged}))
	// 测试里没有 Admin，reload 会立刻落 loadFailed——状态离开 idle 就证明被调到了。
	ov, ok := m2.TopOverlay()
	if !ok {
		t.Fatal("面板应仍在栈上")
	}
	if a, isArchive := ov.(*archiveOverlay); !isArchive || a.state == loadIdle {
		t.Fatalf("档案面板应被重载（state=%v）", ov)
	}
}

// 线/任务/档案面板都要有 r 刷新（此前只有环境面板有）。
func TestPanelsSupportRefreshKey(t *testing.T) {
	for name, ov := range map[string]Overlay{
		"line":    newLineOverlay(),
		"task":    newTaskOverlay(),
		"archive": newArchiveOverlay(),
	} {
		m := testModel()
		m.PushOverlay(ov)
		m, _ = m.Update(runes("r"))
		st, ok := m.TopOverlay()
		if !ok {
			t.Fatalf("%s 面板不该被关掉", name)
		}
		getter, ok := st.(interface{ loadState() loadState })
		if !ok {
			t.Fatalf("%s 面板缺少 loadState 探针", name)
		}
		if getter.loadState() == loadIdle {
			t.Fatalf("%s 面板的 r 应触发重载", name)
		}
	}
}

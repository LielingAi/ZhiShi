package app

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
	"github.com/lielingai/zhishi/tui/internal/protocol"
)

// ══ wire 回看的归约 ═════════════════════════════════════════════════════

func TestReplayWireKinds(t *testing.T) {
	okTrue, okFalse := true, false
	msgs := []protocol.Snapshot{
		{ID: "0", Role: "user", Content: "问题"},
		{ID: "1", Role: "assistant", Content: "回答"},
		{ID: "2", Role: "tool", Name: "Bash", Content: "out", OK: &okTrue},
		{ID: "3", Role: "tool", Name: "Read", Content: "boom", OK: &okFalse},
	}
	st := replayWire(msgs)
	if st.Len() != 4 {
		t.Fatalf("4 条 wire 消息应成 4 个块，实际 %d", st.Len())
	}
	user, _ := st.At(0)
	if user.Kind.String() != "user" || user.Body != "问题" {
		t.Fatalf("user 块不对：%+v", user)
	}
	assistant, _ := st.At(1)
	if assistant.Kind.String() != "assistant" || assistant.Body != "回答" {
		t.Fatalf("assistant 块不对：%+v", assistant)
	}
	tool, _ := st.At(2)
	if tool.Kind.String() != "tool" || tool.Title != "Bash" || tool.Failed {
		t.Fatalf("成功的工具块不对：%+v", tool)
	}
	bad, _ := st.At(3)
	if !bad.Failed {
		t.Fatalf("ok:false 必须映射成 Failed，实际 %+v", bad)
	}
}

func TestReplayWireEmpty(t *testing.T) {
	if st := replayWire(nil); st.Len() != 0 {
		t.Fatalf("空数组应得空 store，实际 %d 块", st.Len())
	}
	if st := replayWire([]protocol.Snapshot{}); st.Len() != 0 {
		t.Fatalf("空切片应得空 store，实际 %d 块", st.Len())
	}
}

func TestReplayWireIsIndependentFromLiveStore(t *testing.T) {
	m := feed(testModel(), protocol.Event{Kind: protocol.KindMessageChunk, Text: "live"})
	liveLen := m.Store.Len()
	st := replayWire([]protocol.Snapshot{{ID: "0", Role: "user", Content: "历史"}})
	if st.Len() != 1 {
		t.Fatalf("回看 store 应独立成形，实际 %d", st.Len())
	}
	if m.Store.Len() != liveLen {
		t.Fatalf("回看不能污染 live 的 Store：%d → %d", liveLen, m.Store.Len())
	}
}

// ══ 历史回看的覆盖层链路 ═══════════════════════════════════════════════

func historyFixture() *fakeAdmin {
	okTrue := true
	return &fakeAdmin{
		sessions: []client.SessionInfo{
			{ID: "s1", LoopSessionID: "ls-1", Title: "旧线 A",
				LastActiveAt: "2026-02-01T09:12:33.000Z", Stats: &client.SessionStats{MessageCount: 3}},
			{ID: "s2", LoopSessionID: "ls-2", Title: "旧线 B"},
		},
		wire: map[string]client.WirePage{
			"ls-1": {Messages: []protocol.Snapshot{
				{ID: "0", Role: "user", Content: "看图"},
				{ID: "1", Role: "tool", Name: "Read", Content: "png bytes", OK: &okTrue},
				{ID: "2", Role: "assistant", Content: "收到"},
			}, Total: 3},
		},
	}
}

func TestHistoryOverlayOpenReplay(t *testing.T) {
	fa := historyFixture()
	m := adminModel(fa)

	m, cmd := m.Update(alt('h'))
	m = pump(t, m, cmd)
	hist, ok := lastOverlayOf[*historyOverlay](&m)
	if !ok || hist.state != loadReady || len(hist.rows) != 2 {
		t.Fatalf("历史列表没加载出来：%+v", hist)
	}
	if !strings.Contains(hist.rows[0].Desc, "2026-02-01") {
		t.Fatalf("行应显示最后活跃时间：%q", hist.rows[0].Desc)
	}
	if hist.rows[0].Ref != "ls-1" {
		t.Fatalf("会话行要带 loopSessionId（回看按它拉 wire）：%q", hist.rows[0].Ref)
	}

	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = pump(t, m, cmd)

	rev, ok := lastOverlayOf[*replayOverlay](&m)
	if !ok {
		t.Fatal("Enter 应压入只读回看层")
	}
	if got := rev.Summary().Count; got != 3 {
		t.Fatalf("回看应有 3 个块，实际 %d", got)
	}
	if len(fa.wireSIDs) != 1 || fa.wireSIDs[0] != "ls-1" {
		t.Fatalf("应按 loopSessionId 拉 wire，实际 %v", fa.wireSIDs)
	}
	if m.Store.Len() != 0 {
		t.Fatalf("回看不能污染当前会话的块表，实际 %d 块", m.Store.Len())
	}
	if len(m.Overlays) != 2 {
		t.Fatalf("回看层应压在历史层之上，实际 %d 层", len(m.Overlays))
	}

	out := m.View()
	if !strings.Contains(out, "只读回看 · 旧线 A") {
		t.Fatalf("顶部应标只读回看与线标题：\n%s", out)
	}
	if !strings.Contains(out, "看图") || !strings.Contains(out, "png bytes") {
		t.Fatalf("回看内容没画出来：\n%s", out)
	}
}

func TestHistoryReplayEscBackToListThenClose(t *testing.T) {
	m := adminModel(historyFixture())
	m, cmd := m.Update(alt('h'))
	m = pump(t, m, cmd)
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = pump(t, m, cmd)

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if _, ok := lastOverlayOf[*replayOverlay](&m); ok {
		t.Fatal("第一次 Esc 应关回看层")
	}
	if _, ok := lastOverlayOf[*historyOverlay](&m); !ok {
		t.Fatal("回看层关掉后应回到历史列表")
	}

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if _, ok := m.TopOverlay(); ok {
		t.Fatal("再按 Esc 应关掉列表")
	}
}

func TestReplayIsReadOnly(t *testing.T) {
	m := adminModel(historyFixture())
	m, cmd := m.Update(alt('h'))
	m = pump(t, m, cmd)
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = pump(t, m, cmd)

	// Enter 不发消息，只回提示。
	_, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("只读回看里 Enter 应明确回一条提示（不能静默）")
	}
	msg, ok := cmd().(noticeMsg)
	if !ok || !strings.Contains(string(msg), "只读") {
		t.Fatalf("Enter 应提示只读，实际 %T %v", cmd(), msg)
	}

	// 复制是唯一放行的动作。
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
	if cmd == nil {
		t.Fatal("y 应触发复制")
	}
}

func TestReplayWindowCapsAt200(t *testing.T) {
	msgs := make([]protocol.Snapshot, 500)
	for i := range msgs {
		msgs[i] = protocol.Snapshot{ID: fmt.Sprint(i), Role: "user", Content: fmt.Sprintf("m%d", i)}
	}
	fa := &fakeAdmin{
		sessions: []client.SessionInfo{{ID: "s1", LoopSessionID: "ls-1", Title: "长线"}},
		wire: map[string]client.WirePage{
			"ls-1": {Messages: msgs, Total: 500},
		},
	}
	m := adminModel(fa)
	m, cmd := m.Update(alt('h'))
	m = pump(t, m, cmd)
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = pump(t, m, cmd)

	rev, ok := lastOverlayOf[*replayOverlay](&m)
	if !ok {
		t.Fatal("应压入回看层")
	}
	if got := rev.Summary().Count; got != wireWindow {
		t.Fatalf("只保留最近 %d 条，实际 %d", wireWindow, got)
	}
	if !strings.Contains(rev.note, "仅显示最近 200 条") {
		t.Fatalf("截断要有提示，实际 %q", rev.note)
	}
	// 保留的是"最近"那一段。
	if b, _ := rev.blocks.At(0); !strings.HasPrefix(b.Body, "m300") {
		t.Fatalf("应保留最近 200 条（从 m300 起），实际首条 %q", b.Body)
	}
}

func TestHistoryLoadFailureKeepsList(t *testing.T) {
	fa := &fakeAdmin{
		sessions: []client.SessionInfo{{ID: "s1", LoopSessionID: "ls-1", Title: "旧线"}},
		wireErr:  errors.New("forbidden"),
	}
	m := adminModel(fa)
	m, cmd := m.Update(alt('h'))
	m = pump(t, m, cmd)
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = pump(t, m, cmd)

	if _, ok := lastOverlayOf[*replayOverlay](&m); ok {
		t.Fatal("加载失败不该压入空回看层")
	}
	hist, ok := lastOverlayOf[*historyOverlay](&m)
	if !ok || !strings.Contains(hist.note, "forbidden") {
		t.Fatalf("失败应在列表里报出来：%+v", hist)
	}
}

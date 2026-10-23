package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
	"github.com/lielingai/zhishi/tui/internal/protocol"
	"github.com/lielingai/zhishi/tui/internal/store"
)

func taskOverlayWith(m Model, rows ...row) Model {
	ov := newTaskOverlay()
	ov.setRows(rows)
	m.PushOverlay(ov)
	return m
}

// 任务面板：c 续命、x 两次确认终止。
func TestTaskOverlayRerunAndStop(t *testing.T) {
	m := taskOverlayWith(testModel(), row{Key: "task-1", Title: "扫描", Flag: "done"})

	m, cmd := m.Update(runes("c"))
	if cmd == nil {
		t.Fatal("c 应发出续命命令")
	}
	msg := cmd().(taskOpDoneMsg)
	if msg.op != "rerun" || msg.id != "task-1" {
		t.Fatalf("续命消息不对：%+v", msg)
	}

	// x 第一次只提示，不执行
	m, cmd = m.Update(runes("x"))
	if cmd != nil {
		t.Fatal("第一次 x 不该直接终止")
	}
	ov, _ := lastOverlayOf[*taskOverlay](&m)
	if !strings.Contains(ov.note, "再按一次") {
		t.Fatalf("应提示二次确认，实际 %q", ov.note)
	}
	// 第二次 x 才终止
	m, cmd = m.Update(runes("x"))
	if cmd == nil {
		t.Fatal("第二次 x 应终止")
	}
	if msg := cmd().(taskOpDoneMsg); msg.op != "stop" {
		t.Fatalf("应为 stop，实际 %s", msg.op)
	}
}

// 会话操作面板：不可用的动作给出原因，而不是静默失败。
func TestSessionOverlayGatesRewind(t *testing.T) {
	m := testModel()
	m = feed(m, protocol.Event{Kind: protocol.KindMessageChunk, Text: "hello"})
	// 本地块（live:assistant）不是权威消息 → 回退/分叉都不可用
	m.PushOverlay(newSessionOverlay(&m))
	ov, _ := lastOverlayOf[*sessionOverlay](&m)
	if ov.items[1].enabled || ov.items[2].enabled {
		t.Fatalf("本地块不该启用回退/分叉：%+v", ov.items)
	}
	// 选中不可用项 → Enter 只回提示
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatal("不可用项不该发命令")
	}
	ov, _ = lastOverlayOf[*sessionOverlay](&m)
	if !strings.Contains(ov.note, "用户消息") {
		t.Fatalf("应说明不可用原因，实际 %q", ov.note)
	}
}

// 权威用户消息块上，回退可用并发命令。
func TestSessionOverlayRewindOnWireUserMessage(t *testing.T) {
	m := testModel()
	m.Store.Upsert(store.Block{ID: "msg:42", Kind: store.KindUser, Version: 1, Body: "hi"})
	m.CursorTouched = true
	m.Cursor = 0
	m.PushOverlay(newSessionOverlay(&m))
	ov, _ := lastOverlayOf[*sessionOverlay](&m)
	if !ov.items[1].enabled {
		t.Fatal("wire 用户消息应启用回退")
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("回退应发命令")
	}
	if msg := cmd().(sessionOpDoneMsg); msg.op != "rewind" {
		t.Fatalf("应为 rewind，实际 %s", msg.op)
	}
}

// 切模型：model/list → 行 → Enter 调 /chat/model。
func TestModelOverlaySwitches(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{models: []client.ModelOption{
		{ProviderID: "deepseek", Provider: "DeepSeek", Model: "deepseek-v4-pro"},
		{ProviderID: "zhipu", Provider: "智谱", Model: "glm-5"},
	}}
	m.PushOverlay(newSessionOverlay(&m))
	// 选到"切换模型"（第 4 项）并执行
	for i := 0; i < 3; i++ {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("应加载模型列表")
	}
	msg := cmd()
	m, _ = m.Update(msg)
	ov, ok := lastOverlayOf[*modelOverlay](&m)
	if !ok || ov.state != loadReady {
		t.Fatalf("模型列表应就绪：%+v", ov)
	}
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("Enter 应发切模型命令")
	}
	sw := cmd().(modelSwitchDoneMsg)
	if sw.provider != "deepseek" || sw.model != "deepseek-v4-pro" {
		t.Fatalf("切模型参数不对：%+v", sw)
	}
}

// 成功回执 → 提示 + 重连（重新拉权威历史）。
func TestSessionOpDoneReconnects(t *testing.T) {
	m := testModel()
	m2, cmd := m.Update(sessionOpDoneMsg{op: "rewind"})
	if cmd == nil {
		t.Fatal("回退成功后应重连")
	}
	if !strings.Contains(m2.LastNotice, "回退") {
		t.Fatalf("应有提示，实际 %q", m2.LastNotice)
	}
}

// 模型列表的可用性标记：没配 key 的 provider 要弱化并标出来，当前模型要标「当前」。
func TestModelOverlayMarksAvailability(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{models: []client.ModelOption{
		{ProviderID: "deepseek", Provider: "DeepSeek", Model: "v4", Status: "valid", Current: true},
		{ProviderID: "kimi", Provider: "Kimi", Model: "k3", Status: "not-set"},
	}}
	m.PushOverlay(newModelOverlay())
	m, cmd := m.Update(modelsLoadedMsg{options: []client.ModelOption{
		{ProviderID: "deepseek", Provider: "DeepSeek", Model: "v4", Status: "valid", Current: true},
		{ProviderID: "kimi", Provider: "Kimi", Model: "k3", Status: "not-set"},
	}})
	_ = cmd
	ov, ok := lastOverlayOf[*modelOverlay](&m)
	if !ok || len(ov.rows) != 2 {
		t.Fatalf("应有 2 行，实际 %+v", ov)
	}
	if ov.rows[0].Flag != "当前" {
		t.Fatalf("当前模型应标「当前」：%+v", ov.rows[0])
	}
	if !ov.rows[1].Dim || !strings.Contains(ov.rows[1].Desc, "not-set") {
		t.Fatalf("无 key 的项应弱化并标注：%+v", ov.rows[1])
	}
}

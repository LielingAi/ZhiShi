package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
	"github.com/lielingai/zhishi/tui/internal/protocol"
)

// ══ attach 字节泵 ═══════════════════════════════════════════════════════

// fakeTermConn 是可编排的帧通道：Send 记下来，Recv 由测试推。
type fakeTermConn struct {
	sent    chan []byte
	recv    chan []byte
	sendErr error

	mu     sync.Mutex
	closed bool
}

func newFakeTermConn() *fakeTermConn {
	return &fakeTermConn{sent: make(chan []byte, 64), recv: make(chan []byte, 64)}
}

func (f *fakeTermConn) Send(ctx context.Context, frame []byte) error {
	if f.sendErr != nil {
		return f.sendErr
	}
	select {
	case f.sent <- frame:
	case <-ctx.Done():
	}
	return nil
}

func (f *fakeTermConn) Recv(ctx context.Context) ([]byte, error) {
	select {
	case b, ok := <-f.recv:
		if !ok {
			return nil, io.EOF
		}
		return b, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (f *fakeTermConn) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	return nil
}

func (f *fakeTermConn) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

// syncBuffer 是并发安全的 writer（泵在 goroutine 里写，测试在主 goroutine 读）。
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// fakeClock 让"两次 Ctrl-] 的 2 秒窗口"可测。
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type attachHarness struct {
	in     *io.PipeWriter
	out    *syncBuffer
	conn   *fakeTermConn
	resize chan struct{}
	clock  *fakeClock

	mu   sync.Mutex
	size [2]int

	done chan attachResult
}

type attachResult struct {
	code int
	err  error
}

func newAttachHarness(t *testing.T) *attachHarness {
	t.Helper()
	pr, pw := io.Pipe()
	h := &attachHarness{
		in:     pw,
		out:    &syncBuffer{},
		conn:   newFakeTermConn(),
		resize: make(chan struct{}, 4),
		clock:  &fakeClock{t: time.Unix(1700000000, 0)},
		size:   [2]int{80, 24},
		done:   make(chan attachResult, 1),
	}
	go func() {
		code, err := runAttachPump(attachOpts{
			Ctx:  context.Background(),
			In:   pr,
			Out:  h.out,
			Conn: h.conn,
			Size: func() (int, int) {
				h.mu.Lock()
				defer h.mu.Unlock()
				return h.size[0], h.size[1]
			},
			Resizes: h.resize,
			Now:     h.clock.Now,
		})
		h.done <- attachResult{code: code, err: err}
	}()
	t.Cleanup(func() {
		_ = pw.Close()
		_ = pr.Close()
	})
	return h
}

func (h *attachHarness) setSize(cols, rows int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.size = [2]int{cols, rows}
}

// nextFrame 取下一条发送的帧（带超时，避免卡死测试）。
func (h *attachHarness) nextFrame(t *testing.T) client.TermFrame {
	t.Helper()
	select {
	case raw := <-h.conn.sent:
		var fr client.TermFrame
		if err := json.Unmarshal(raw, &fr); err != nil {
			t.Fatalf("发出的帧不是合法 JSON：%s", raw)
		}
		return fr
	case <-time.After(2 * time.Second):
		t.Fatal("等不到发送的帧")
		return client.TermFrame{}
	}
}

func (h *attachHarness) expectNoFrame(t *testing.T, wait time.Duration) {
	t.Helper()
	select {
	case raw := <-h.conn.sent:
		t.Fatalf("不该有帧，实际收到 %s", raw)
	case <-time.After(wait):
	}
}

func (h *attachHarness) push(t *testing.T, frame string) {
	t.Helper()
	select {
	case h.conn.recv <- []byte(frame):
	case <-time.After(2 * time.Second):
		t.Fatal("推帧超时")
	}
}

func (h *attachHarness) wait(t *testing.T) attachResult {
	t.Helper()
	select {
	case res := <-h.done:
		return res
	case <-time.After(2 * time.Second):
		t.Fatal("泵没有结束")
		return attachResult{}
	}
}

func (h *attachHarness) stillRunning(t *testing.T) {
	t.Helper()
	select {
	case res := <-h.done:
		t.Fatalf("泵不该结束，实际返回 code=%d err=%v", res.code, res.err)
	case <-time.After(60 * time.Millisecond):
	}
}

func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("等待超时：%s", what)
}

func TestAttachSendsInitialResize(t *testing.T) {
	h := newAttachHarness(t)
	fr := h.nextFrame(t)
	if fr.Type != "resize" || fr.Cols != 80 || fr.Rows != 24 {
		t.Fatalf("进入时应先发一次尺寸，实际 %+v", fr)
	}
}

func TestAttachInputBecomesFrames(t *testing.T) {
	h := newAttachHarness(t)
	_ = h.nextFrame(t) // 初始 resize

	if _, err := h.in.Write([]byte("ls -la\r")); err != nil {
		t.Fatalf("写输入失败：%v", err)
	}
	fr := h.nextFrame(t)
	if fr.Type != "input" || fr.Data != "ls -la\r" {
		t.Fatalf("输入应原样包成 input 帧，实际 %+v", fr)
	}
}

func TestAttachOutputGoesToWriter(t *testing.T) {
	h := newAttachHarness(t)
	_ = h.nextFrame(t)

	h.push(t, `{"type":"output","data":"hello "}`)
	h.push(t, `{"type":"output","data":"world"}`)
	waitFor(t, func() bool { return h.out.String() == "hello world" }, "输出落到 writer")
}

func TestAttachResizeOnlyOnChange(t *testing.T) {
	h := newAttachHarness(t)
	if fr := h.nextFrame(t); fr.Type != "resize" {
		t.Fatalf("首帧应是 resize，实际 %+v", fr)
	}

	// 尺寸没变：不许打扰远端。
	h.resize <- struct{}{}
	h.expectNoFrame(t, 80*time.Millisecond)

	h.setSize(120, 40)
	h.resize <- struct{}{}
	fr := h.nextFrame(t)
	if fr.Type != "resize" || fr.Cols != 120 || fr.Rows != 40 {
		t.Fatalf("尺寸变化应发 resize 120x40，实际 %+v", fr)
	}
}

func TestAttachExitFrameEndsPumpWithCode(t *testing.T) {
	h := newAttachHarness(t)
	_ = h.nextFrame(t)

	h.push(t, `{"type":"exit","code":7}`)
	res := h.wait(t)
	if res.code != 7 || res.err != nil {
		t.Fatalf("exit 帧应返回 (7, nil)，实际 (%d, %v)", res.code, res.err)
	}
}

func TestAttachErrorFrameEndsPumpWithError(t *testing.T) {
	h := newAttachHarness(t)
	_ = h.nextFrame(t)

	h.push(t, `{"type":"error","message":"loadNodePty 失败"}`)
	res := h.wait(t)
	if res.err == nil || !strings.Contains(res.err.Error(), "loadNodePty") {
		t.Fatalf("error 帧应带回原因，实际 %v", res.err)
	}
}

func TestAttachExitKeyNeedsTwoPresses(t *testing.T) {
	h := newAttachHarness(t)
	_ = h.nextFrame(t)

	if _, err := h.in.Write([]byte{exitKeyByte}); err != nil {
		t.Fatal(err)
	}
	// 单次：只提示，不退出，也不把 Ctrl-] 转发给远端。
	waitFor(t, func() bool { return strings.Contains(h.out.String(), "Ctrl-]") }, "第一次按键的提示")
	h.stillRunning(t)
	h.expectNoFrame(t, 50*time.Millisecond)

	// 2 秒内第二次：退出。
	if _, err := h.in.Write([]byte{exitKeyByte}); err != nil {
		t.Fatal(err)
	}
	res := h.wait(t)
	if !errors.Is(res.err, errDetached) {
		t.Fatalf("第二次 Ctrl-] 应返回 errDetached，实际 (%d, %v)", res.code, res.err)
	}
}

func TestAttachExitKeyWindowExpires(t *testing.T) {
	h := newAttachHarness(t)
	_ = h.nextFrame(t)

	_, _ = h.in.Write([]byte{exitKeyByte})
	waitFor(t, func() bool { return strings.Count(h.out.String(), "Ctrl-]") == 1 }, "第一次提示")
	h.stillRunning(t)

	// 超过窗口再按：又只是一次提示，不退出。
	h.clock.advance(3 * time.Second)
	_, _ = h.in.Write([]byte{exitKeyByte})
	waitFor(t, func() bool { return strings.Count(h.out.String(), "Ctrl-]") == 2 }, "第二次提示")
	h.stillRunning(t)
}

func TestAttachExitKeyIsNotForwarded(t *testing.T) {
	h := newAttachHarness(t)
	_ = h.nextFrame(t)

	// 一格里混合普通字符与 Ctrl-]：普通字符照发，Ctrl-] 被摘掉。
	_, _ = h.in.Write([]byte{'a', exitKeyByte, 'b'})
	fr := h.nextFrame(t)
	if fr.Type != "input" || fr.Data != "ab" {
		t.Fatalf("Ctrl-] 不该转发给远端，实际 %+v", fr)
	}
}

func TestAttachCtrlCIsForwarded(t *testing.T) {
	h := newAttachHarness(t)
	_ = h.nextFrame(t)

	// Ctrl-C 必须透传（attach 的退出键刻意不用它）。
	_, _ = h.in.Write([]byte{0x03})
	fr := h.nextFrame(t)
	if fr.Type != "input" || fr.Data != "\x03" {
		t.Fatalf("Ctrl-C 应原样透传，实际 %+v", fr)
	}
}

func TestAttachInputClosedKeepsPumpAlive(t *testing.T) {
	h := newAttachHarness(t)
	_ = h.nextFrame(t)

	_ = h.in.Close() // stdin 关了：不该把 attach 一起结束
	h.stillRunning(t)
	h.push(t, `{"type":"exit","code":0}`)
	if res := h.wait(t); res.code != 0 {
		t.Fatalf("退出码应为 0，实际 %d", res.code)
	}
}

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

// ══ Alt+s / attach 入口 ════════════════════════════════════════════════

func TestAltSAttachPrefersSelectedEnv(t *testing.T) {
	m := testModel()
	m.EnvironmentID = "local"
	m.SelectedEnvID = "kali-lab"

	// 没有 client 时给提示（不 panic、不空转）。
	_, cmd := m.Update(alt('s'))
	if cmd == nil {
		t.Fatal("Alt+s 应回一条消息")
	}
	if _, ok := cmd().(noticeMsg); !ok {
		t.Fatalf("没有 sidecar 时应回提示，实际 %T", cmd())
	}
}

func TestEnvOverlaySTriggersAttach(t *testing.T) {
	fa := &fakeAdmin{envs: []client.EnvironmentInfo{
		{ID: "local", Kind: "local", Name: "本机"},
		{ID: "kali", Kind: "ssh", Host: "h"},
	}}
	m := adminModel(fa)
	// attach 需要 sidecar 客户端（这里只构造，Cmd 不会真的拨号）。
	m.Client = client.New("http://127.0.0.1:1", "")
	m, cmd := m.Update(alt('e'))
	m = pump(t, m, cmd)
	if m.SelectedEnvID != "local" {
		t.Fatalf("加载后光标应落在第一条并同步 SelectedEnvID，实际 %q", m.SelectedEnvID)
	}

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	if m.SelectedEnvID != "kali" {
		t.Fatalf("移动光标应同步 SelectedEnvID，实际 %q", m.SelectedEnvID)
	}

	// s = attach 选中行（Enter 仍是切环境，语义不混）。
	_, cmd = m.Update(runes("s"))
	if cmd == nil {
		t.Fatal("s 应发起 attach")
	}
	if got := fmt.Sprintf("%T", cmd()); got != "tea.execMsg" {
		t.Fatalf("attach 应走 tea.Exec（返回 execMsg），实际 %s", got)
	}
	// attach 不该顺手切环境。
	if len(fa.selected) != 0 {
		t.Fatalf("attach 不该调用 environment/select，实际 %v", fa.selected)
	}
}

func TestAttachDoneLandsInStatusLine(t *testing.T) {
	m := testModel()
	m, _ = m.Update(attachDoneMsg{envID: "kali", code: 3})
	if !strings.Contains(m.LastNotice, "[attach 结束 code=3]") {
		t.Fatalf("exit 帧应把 code 报到状态行，实际 %q", m.LastNotice)
	}

	m, _ = m.Update(attachDoneMsg{envID: "kali", code: -1, err: errDetached})
	if !strings.Contains(m.LastNotice, "已断开 attach") {
		t.Fatalf("Ctrl-] 退出应给不同提示，实际 %q", m.LastNotice)
	}

	m, _ = m.Update(attachDoneMsg{envID: "kali", code: -1, err: errors.New("spawn 失败")})
	if !strings.Contains(m.LastErr, "spawn 失败") {
		t.Fatalf("失败应进错误行，实际 %q", m.LastErr)
	}
}

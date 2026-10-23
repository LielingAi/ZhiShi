package app

import (
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/lielingai/zhishi/tui/internal/client"
	"github.com/lielingai/zhishi/tui/internal/store"
)

// ── 覆盖层叠绘 ─────────────────────────────────────────────────────────

func TestOverlayDoesNotJoinLayout(t *testing.T) {
	m := testModel()
	for i := 0; i < 6; i++ {
		m.Store.Upsert(store.Block{ID: string(rune('a' + i)), Kind: store.KindAssistant, Version: 1, Body: "body"})
	}
	m.layout()
	base := strings.Split(m.View(), "\n")

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	withOverlay := strings.Split(m.View(), "\n")

	// 叠绘不改变画面行数：覆盖层是盖上去的，不是插进 JoinVertical 的一段。
	if len(withOverlay) != len(base) {
		t.Fatalf("叠绘后行数变了：%d → %d", len(base), len(withOverlay))
	}
	if len(withOverlay) != m.Height {
		t.Fatalf("画面应为 %d 行，实际 %d 行", m.Height, len(withOverlay))
	}
	// 头一行（header）不该被覆盖层碰：它不在中心行区间里。
	if withOverlay[0] != base[0] {
		t.Fatalf("header 被覆盖层改写了：\n%q\n%q", base[0], withOverlay[0])
	}
	drawn := strings.Join(withOverlay, "\n")
	if !strings.Contains(drawn, "动作中心") {
		t.Fatalf("覆盖层没画出来：\n%s", drawn)
	}
	if !strings.Contains(drawn, "↑↓ 选择") {
		t.Fatalf("覆盖层缺少底注提示：\n%s", drawn)
	}
}

func TestNoticeOverlayStillDrawn(t *testing.T) {
	m := testModel()
	m.PushOverlay(newNoticeOverlay("动作层", "M1 空壳"))
	out := m.View()
	if !strings.Contains(out, "动作层") || !strings.Contains(out, "Esc 关闭") {
		t.Fatalf("空壳覆盖层没画出来：\n%s", out)
	}
}

func TestPaletteOverlayShowsSelection(t *testing.T) {
	m := testModel()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	out := m.View()
	if !strings.Contains(out, "▸ 会话操作") {
		t.Fatalf("选中项应有 ▸ 标记：\n%s", out)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	out = m.View()
	if strings.Contains(out, "▸ 会话操作") {
		t.Fatalf("移动后第一项不该还是选中态：\n%s", out)
	}
	if !strings.Contains(out, "▸ 打开环境面板") {
		t.Fatalf("第二项应被选中：\n%s", out)
	}
}

// ── 帧投影 ─────────────────────────────────────────────────────────────

func TestFrameProjectsRowsToBlocks(t *testing.T) {
	m := longToolModel(t)
	_ = m.View()

	if m.Frame == nil {
		t.Fatal("渲染后应有帧投影")
	}
	if m.Frame.width != m.Width || m.Frame.height != m.Height {
		t.Fatalf("投影尺寸应与当前尺寸一致：%+v", m.Frame)
	}
	if m.Frame.streamTop != 1 {
		t.Fatalf("stream 应从第 2 行开始（header 占 1 行），实际 %d", m.Frame.streamTop)
	}
	if len(m.Frame.rows) != m.StreamHeight() {
		t.Fatalf("投影行数应等于 stream 高度：%d vs %d", len(m.Frame.rows), m.StreamHeight())
	}
	if got := m.Frame.rows[0].ID; got != "tool:t1" {
		t.Fatalf("第一行应属于唯一的块，实际 %q", got)
	}
	if !m.Frame.rows[0].Head {
		t.Fatal("第一行应是块头")
	}
	if m.Frame.rows[1].Head {
		t.Fatal("第二行是正文，不该标成块头")
	}
	// 空行没有归属块，鼠标点上去应当什么都不发生。
	if id := m.Frame.rows[len(m.Frame.rows)-1].ID; id != "" {
		t.Fatalf("内容不满一屏时底部应是空行，实际归属 %q", id)
	}
}

func TestFrameProjectionGuardAfterResize(t *testing.T) {
	m := longToolModel(t)
	_ = m.View()
	y := headRow(t, m, "tool:t1")

	// resize 之后还没重新渲染：投影是过期的，这一击必须被忽略，
	// 否则会把用户点到的那一行算到别的块上。
	m, _ = m.Update(tea.WindowSizeMsg{Width: m.Width, Height: m.Height - 6})
	m, _ = m.Update(tea.MouseMsg{
		Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: 2, Y: y,
	})
	if b, _ := m.Store.Get("tool:t1"); b.Expanded {
		t.Fatal("投影过期时不该命中块头")
	}
}

func TestEmptyStreamShowsPlaceholder(t *testing.T) {
	m := testModel()
	out := m.View()
	if !strings.Contains(out, "还没有内容") {
		t.Fatalf("空会话应给引导语：\n%s", out)
	}
	if n := len(strings.Split(out, "\n")); n != m.Height {
		t.Fatalf("空会话也要占满 %d 行，实际 %d", m.Height, n)
	}
}

// ── M2a：数据覆盖层的叠绘 ──────────────────────────────────────────────

func TestDataOverlayDoesNotReflowStream(t *testing.T) {
	m := testModel()
	for i := 0; i < 5; i++ {
		m.Store.Upsert(store.Block{
			ID: string(rune('a' + i)), Kind: store.KindAssistant, Version: 1, Body: "body",
		})
	}
	m.ScrollLines = 0
	base := strings.Split(m.View(), "\n")

	m.Admin = &fakeAdmin{envs: []client.EnvironmentInfo{{ID: "local", Kind: "local", Name: "本机"}}}
	m, cmd := m.Update(alt('e'))
	m = pump(t, m, cmd)
	drawn := strings.Split(m.View(), "\n")

	if len(drawn) != len(base) {
		t.Fatalf("叠绘改变了行数：%d → %d", len(base), len(drawn))
	}
	if drawn[0] != base[0] {
		t.Fatalf("header 被覆盖层改写：\n%q\n%q", base[0], drawn[0])
	}
	// 状态两行在最底下，盒子居中不会碰到它们——底层布局没重排的硬证据。
	if got, want := drawn[len(drawn)-1], base[len(base)-1]; got != want {
		t.Fatalf("状态行被改写：\n%q\n%q", want, got)
	}
	if m.ScrollLines != 0 {
		t.Fatalf("打开覆盖层不该改变滚动位置，实际 %d", m.ScrollLines)
	}
	if !strings.Contains(strings.Join(drawn, "\n"), "本机") {
		t.Fatal("覆盖层内容没画出来")
	}
}

func TestOverlayEmptyListState(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{envs: nil} // 成功但空列表
	m, cmd := m.Update(alt('e'))
	m = pump(t, m, cmd)

	out := m.View()
	if !strings.Contains(out, "（空）") {
		t.Fatalf("空列表要明确画「（空）」而不是留白：\n%s", out)
	}
	if s, _ := m.TopOverlay(); s.Summary().State != "ready" {
		t.Fatalf("空列表属于就绪态，实际 %+v", s.Summary())
	}
}

func TestOverlayErrorStateDrawing(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{archiveErr: errors.New("archive/list: 会话未锚定（先开/接会话）")}
	m, cmd := m.Update(alt('a'))
	m = pump(t, m, cmd)

	out := m.View()
	if !strings.Contains(out, "会话未锚定") {
		t.Fatalf("档案面板应把服务端错误原文画出来：\n%s", out)
	}
	if !strings.Contains(out, "研究档案") {
		t.Fatalf("错误态也要保留标题（用户要知道是哪一层出错）：\n%s", out)
	}
	if _, ok := m.TopOverlay(); !ok {
		t.Fatal("错误态不该关面板")
	}
}

func TestLoadingStateDrawing(t *testing.T) {
	m := testModel()
	m.Admin = &fakeAdmin{}
	m, cmd := m.Update(alt('l'))
	if cmd == nil {
		t.Fatal("打开应发加载命令")
	}
	// 还没喂回包：应看到加载中。
	if out := m.View(); !strings.Contains(out, "加载中") {
		t.Fatalf("回包之前应画加载中：\n%s", out)
	}
}

// 内容整体左缩进 1 列：不留白会贴着终端边框；同时任何一行都不得超宽。
func TestViewLeftMarginAndWidth(t *testing.T) {
	m := testModel() // 100x30
	for _, l := range strings.Split(m.View(), "\n") {
		if w := lipgloss.Width(l); w > m.Width {
			t.Fatalf("行宽 %d 超过 %d：%q", w, m.Width, l)
		}
		if l != "" && !strings.HasPrefix(l, " ") {
			t.Fatalf("每行应有 1 列左缩进：%q", l)
		}
	}
}

// 标题行只留 host:port，并带一条分隔线——否则滚动后标题和正文混在一起。
func TestHeaderShortServerAndRule(t *testing.T) {
	m := testModel()
	m.Server = "http://192.168.88.1:7411"
	out := m.View()
	if strings.Contains(out, "http://") {
		t.Fatalf("标题不该带协议前缀：\n%s", out)
	}
	if !strings.Contains(out, "192.168.88.1:7411") {
		t.Fatalf("标题应显示 host:port：\n%s", out)
	}
	if !strings.Contains(out, "─") {
		t.Fatalf("应有标题分隔线：\n%s", out)
	}
}

// F1 键位总表：状态行只留高频键，其余收进覆盖层。
func TestF1OpensHelpOverlay(t *testing.T) {
	m := testModel()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyF1})
	ov, ok := m.TopOverlay()
	if !ok {
		t.Fatal("F1 应打开键位表")
	}
	if _, isHelp := ov.(*helpOverlay); !isHelp {
		t.Fatalf("栈顶应是键位表，实际 %T", ov)
	}
	out := m.View()
	for _, want := range []string{"Alt+r", "F2", "Ctrl+C"} {
		if !strings.Contains(out, want) {
			t.Fatalf("键位表应包含 %q：\n%s", want, out)
		}
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if _, ok := m.TopOverlay(); ok {
		t.Fatal("Esc 应关闭键位表")
	}
}

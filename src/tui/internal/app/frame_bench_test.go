package app

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/render"
	"github.com/lielingai/zhishi/tui/internal/store"
)

// frameBlocks / frameWidth / frameHeight 是验收要求的规模：
// 1200 个块、120 列（高度也取 120，一个满屏的终端）。
const (
	frameBlocks = 1200
	frameWidth  = 120
	frameHeight = 120
)

// bigModel 造一个"足够像真的"大会话：每条正文都有唯一标识，方便断言
// "某个块到底有没有被渲染"。
func bigModel(tb testing.TB) Model {
	tb.Helper()
	m := NewModel("http://127.0.0.1:7411", nil)
	m.Width, m.Height = frameWidth, frameHeight
	m.layout()
	for i := 0; i < frameBlocks; i++ {
		b := store.Block{
			ID:      fmt.Sprintf("b%04d", i),
			Version: 1,
			Body: fmt.Sprintf("block-%04d lorem ipsum dolor sit amet consectetur adipiscing elit\n"+
				"second line of block-%04d with a bit more text to make it realistic", i, i),
		}
		switch i % 5 {
		case 0:
			b.Kind = store.KindUser
		case 3:
			b.Kind, b.Title = store.KindTool, "Bash"
		case 4:
			b.Kind, b.Title = store.KindTool, "Read"
		default:
			b.Kind = store.KindAssistant
		}
		m.Store.Upsert(b)
	}
	return m
}

// TestFrameBudget 是 M1 的性能闸：1200 个块跑一次 View() 必须远低于 50ms。
//
// 冷启动（高度缓存还空着）是真正的最坏情况。这里对三个各自全新的 Model 各测
// 一帧取最大值——本机的单调时钟粒度很粗（单发测量会读到 0ns），取最大值
// 才能保证"读到 0"不是把慢帧掩盖过去。
func TestFrameBudget(t *testing.T) {
	const rounds = 3

	// 先把三个"各自冷缓存"的 Model 都造好，再做一次 GC：把造数据的分配成本
	// 从计时窗口里摘出去（否则测到的是"造 1200 个块 + 一次 GC"，不是画一帧）。
	models := make([]Model, rounds)
	for i := range models {
		models[i] = bigModel(t)
	}
	runtime.GC()

	var cold, warm time.Duration
	var out string
	for i := range models {
		s := time.Now()
		out = models[i].View()
		if d := time.Since(s); d > cold {
			cold = d
		}
	}
	m := models[rounds-1]
	lines := strings.Count(out, "\n") + 1

	for i := 0; i < rounds; i++ {
		s := time.Now()
		_ = m.View()
		if d := time.Since(s); d > warm {
			warm = d
		}
	}

	// 对照：M0 式的"每帧全量渲染"。用另一个 Cache，免得污染上一帧的缓存。
	naive := render.NewCache()
	naiveStart := time.Now()
	_ = naive.Stream(m.VisibleBlocks(), m.VisibleWidth())
	naiveCost := time.Since(naiveStart)

	t.Logf("1200 块 / %d 列 / %d 行视口：冷帧 max %v，热帧 max %v，输出 %d 行，Block 调用 %d 次（真实渲染 %d 次）",
		m.Width, m.Height, cold, warm, lines, m.Cache.Calls(), m.Cache.Renders())
	t.Logf("对照：全量渲染 1200 块需要 %v（虚拟滚动省掉的就是这笔）", naiveCost)

	if lines != m.Height {
		t.Fatalf("画面应为 %d 行，实际 %d 行", m.Height, lines)
	}
	if cold > 50*time.Millisecond {
		t.Fatalf("冷帧 %v 超出 50ms 预算（虚拟滚动没生效？）", cold)
	}
}

// BenchmarkFrame1200x120 测的是稳态帧（高度缓存已建立）。
func BenchmarkFrame1200x120(b *testing.B) {
	m := bigModel(b)
	_ = m.View() // 预热：让块高缓存建立
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = m.View()
	}
}

// TestFrameOnlyRendersVisibleWindow 是虚拟滚动的核心断言：
// 没进视口的块不该被问过，更不该被渲染。
func TestFrameOnlyRendersVisibleWindow(t *testing.T) {
	m := bigModel(t)
	out := m.View()

	calls := m.Cache.Calls()
	renders := m.Cache.Renders()
	streamH := m.StreamHeight()
	// 上界 = 视口行数（每块至少 1 行）+ 两侧缓冲 + 一轮自校正的 growBlocks。
	upper := streamH + 2*streamBufferBlocks + growBlocks
	if calls > upper {
		t.Fatalf("Block 调用 %d 次，超出窗口+缓冲上界 %d 次——有块没进视口也被渲染了", calls, upper)
	}
	if calls >= frameBlocks/4 {
		t.Fatalf("Block 调用 %d 次（总量 %d），虚拟滚动没生效", calls, frameBlocks)
	}
	if renders > calls {
		t.Fatalf("渲染次数 %d 大于调用次数 %d（不可能）", renders, calls)
	}

	// 内容层证据：最后一块在画面上，第一块不在。
	if !strings.Contains(out, "block-1199") {
		t.Fatal("贴底时应该看得到最后一块")
	}
	if strings.Contains(out, "block-0000") {
		t.Fatal("贴底时不该渲染第一块")
	}
}

// TestFrameScrollUpShowsEarlierBlocks 证明滚动真的换了窗口，而不是"只画最后几块"。
func TestFrameScrollUpShowsEarlierBlocks(t *testing.T) {
	m := bigModel(t)
	bottom := m.View()
	if !strings.Contains(bottom, "block-1199") {
		t.Fatal("初始应贴底")
	}

	// 往上翻到顶（远超总量后由画面兜住）：应该看到第一块，看不到最后一块。
	m.ScrollLines = 1 << 20
	top := m.View()
	if strings.Contains(top, "block-1199") {
		t.Fatal("滚到顶后不该还看得到最后一块")
	}
	if !strings.Contains(top, "block-0000") {
		t.Fatalf("滚到顶后应看到第一块，实际画面：\n%s", top)
	}
	if top == bottom {
		t.Fatal("滚动没有改变画面")
	}

	// 中段：往上 600 行（约 200 块）落在 900 多号块附近。
	m.ScrollLines = 600
	mid := m.View()
	if !strings.Contains(mid, "block-09") && !strings.Contains(mid, "block-10") {
		t.Fatalf("上翻 600 行应落在 900~1100 号块区间，实际画面：\n%s", mid)
	}
	if strings.Contains(mid, "block-0000") || strings.Contains(mid, "block-1199") {
		t.Fatal("上翻 600 行既不该见顶也不该见底")
	}
}

// TestFrameReportsMaxScrollAndClamps 验证"走到顶才知道能滚多远"的自校正闭环。
func TestFrameReportsMaxScrollAndClamps(t *testing.T) {
	m := bigModel(t)
	_ = m.View()
	if m.Frame.maxScroll >= 0 {
		t.Fatal("贴底的一帧不该宣称知道最大滚动量（没走到顶）")
	}

	m.ScrollLines = 1 << 20 // 远超内容总量
	_ = m.View()
	max := m.Frame.maxScroll
	if max < 0 {
		t.Fatal("走到顶的一帧应回报 maxScroll")
	}
	if max <= 0 {
		t.Fatalf("1200 块的会话不可能没有可滚量：%d", max)
	}

	// 滚动动作会把它钳回真实范围，用户不用按同样多次才回到底。
	m2, _ := m.Update(pgDown())
	if m2.ScrollLines != max {
		t.Fatalf("ScrollLines 应被钳到 %d，实际 %d", max, m2.ScrollLines)
	}
}

func pgUp() tea.KeyMsg   { return tea.KeyMsg{Type: tea.KeyPgUp} }
func pgDown() tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyPgDown} }

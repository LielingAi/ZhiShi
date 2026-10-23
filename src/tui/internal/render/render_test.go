package render

import (
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/lipgloss"

	"github.com/lielingai/zhishi/tui/internal/store"
)

// 每个测试自建 Cache：缓存键含 block ID，共用实例会互相污染，
// 且"第二次不渲染"的断言会随测试顺序变脸。
func newCache() *Cache { return NewCache() }

func toolBlock(version int) store.Block {
	return store.Block{
		ID:       "tool:1",
		Kind:     store.KindTool,
		Title:    "Bash",
		Version:  version,
		Duration: 1200 * time.Millisecond,
		Body:     "total 0",
	}
}

func TestCacheHitOnIdenticalInput(t *testing.T) {
	c := newCache()
	b := toolBlock(1)

	first := c.Block(b, 80, false)
	second := c.Block(b, 80, false)

	if first != second {
		t.Fatal("同一输入两次渲染结果不一致")
	}
	if got := c.Renders(); got != 1 {
		t.Fatalf("第二次应命中缓存，实际渲染了 %d 次", got)
	}
}

func TestCacheMissOnVersionChange(t *testing.T) {
	c := newCache()
	c.Block(toolBlock(1), 80, false)
	c.Block(toolBlock(2), 80, false)
	if got := c.Renders(); got != 2 {
		t.Fatalf("版本变了必须重渲染，实际渲染 %d 次", got)
	}
}

func TestCacheMissOnWidthChange(t *testing.T) {
	c := newCache()
	c.Block(toolBlock(1), 80, false)
	c.Block(toolBlock(1), 81, false)
	if got := c.Renders(); got != 2 {
		t.Fatalf("宽度变了必须重渲染，实际渲染 %d 次", got)
	}
}

func TestCacheMissOnExpandedToggle(t *testing.T) {
	c := newCache()
	b := toolBlock(1)
	c.Block(b, 80, false)

	b.Expanded = true
	c.Block(b, 80, false)
	if got := c.Renders(); got != 2 {
		t.Fatalf("展开态变了必须重渲染，实际渲染 %d 次", got)
	}
}

func TestCacheMissOnLiveToggle(t *testing.T) {
	c := newCache()
	b := toolBlock(1)
	c.Block(b, 80, false)
	c.Block(b, 80, true)
	if got := c.Renders(); got != 2 {
		t.Fatalf("live 变了必须重渲染，实际渲染 %d 次", got)
	}
}

func TestWidthChangeDropsWholeCache(t *testing.T) {
	c := newCache()
	a := toolBlock(1)
	b := store.Block{ID: "tool:2", Kind: store.KindTool, Title: "Read", Version: 1}
	c.Block(a, 80, false)
	c.Block(b, 80, false)

	// 宽度变化 → 整体失效：两块都要重画。
	c.Block(a, 100, false)
	c.Block(b, 100, false)
	if got := c.Renders(); got != 4 {
		t.Fatalf("宽度变化应整体失效（期望 4 次渲染），实际 %d 次", got)
	}

	// 回到原宽度也不行：换行结果已经不是同一份了。
	c.Block(a, 80, false)
	if got := c.Renders(); got != 5 {
		t.Fatalf("回到旧宽度不应命中旧缓存，实际渲染 %d 次", got)
	}
}

func TestStreamRendersAllBlocksOnce(t *testing.T) {
	c := newCache()
	blocks := []store.Block{toolBlock(1), {ID: "tool:2", Kind: store.KindTool, Title: "Read", Version: 1}}
	out := c.Stream(blocks, 80)
	if strings.Count(out, "▍") != 2 {
		t.Fatalf("两块应有两个块头，实际输出：\n%s", out)
	}
	if got := c.Renders(); got != 2 {
		t.Fatalf("应各渲染一次，实际 %d 次", got)
	}
}

func TestHeaderShape(t *testing.T) {
	c := newCache()
	out := c.Block(toolBlock(1), 80, false)
	// 工具没有真实退出码（sidecar 只给 isError），所以头是 ✓/✗ + 自量耗时，
	// 刻意不印 exit。
	if !strings.Contains(out, "▍ ● Bash  ✓  1.2s") {
		t.Fatalf("块头形状不对：\n%s", out)
	}

	failed := toolBlock(1)
	failed.Failed = true
	failed.Version = 2 // 版本是唯一脏标记：内容变了必须跟着 +1，否则命中旧缓存
	out = c.Block(failed, 80, false)
	if !strings.Contains(out, "▍ ● Bash  ✗  1.2s") {
		t.Fatalf("失败块头应是 ✗：\n%s", out)
	}
	if strings.Contains(out, "exit=") {
		t.Fatalf("不该出现 exit=（前端拿不到真实退出码）：\n%s", out)
	}
}

func TestBodyFoldedByDefault(t *testing.T) {
	c := newCache()
	b := toolBlock(1)
	var lines []string
	for i := 0; i < 20; i++ {
		lines = append(lines, "line")
	}
	b.Body = strings.Join(lines, "\n")

	folded := c.Block(b, 80, false)
	if !strings.Contains(folded, "Alt+r") {
		t.Fatalf("折叠态应提示展开方式：\n%s", folded)
	}
	if n := strings.Count(folded, "line"); n != 1 { // 只剩块头里的首行摘要
		t.Fatalf("折叠态正文应全部隐藏，只留块头摘要，实际 %d 行", n)
	}

	b.Expanded = true
	expanded := c.Block(b, 80, false)
	if strings.Contains(expanded, "Alt+r") {
		t.Fatalf("展开态不该再提示：\n%s", expanded)
	}
	if n := strings.Count(expanded, "line"); n != 20 {
		t.Fatalf("展开态应显示全部 20 行，实际 %d 行", n)
	}
}

func TestWrapKeepsWideCharsInsideWidth(t *testing.T) {
	c := newCache()
	b := toolBlock(1)
	b.Body = strings.Repeat("中文", 40) // 80 个全角字符 = 160 列
	out := c.Block(b, 40, false)
	for _, line := range strings.Split(out, "\n") {
		// lipgloss.Width 是显示宽度：中文算 2 列。这里直接量不超过 40。
		if w := lipgloss.Width(line); w > 40 {
			t.Fatalf("折行超出宽度（%d 列）：%q", w, line)
		}
	}
}

// ── M1：高度缓存 ───────────────────────────────────────────────────────

// longBodyBlock 造一个 20 行的块（折叠态 6 行 + 1 行省略提示）。
func longBodyBlock(version int) store.Block {
	b := toolBlock(version)
	lines := make([]string, 20)
	for i := range lines {
		lines[i] = "line"
	}
	b.Body = strings.Join(lines, "\n")
	return b
}

func TestFoldHintFormat(t *testing.T) {
	c := newCache()
	out := c.Block(longBodyBlock(1), 80, false)
	// 折叠提示是设计定稿的一句话，测试盯着它，免得随手改字。
	if !strings.Contains(out, "还有 20 行（Alt+r）") {
		t.Fatalf("折叠提示文案不对：\n%s", out)
	}
}

func TestHeightMatchesRenderedLines(t *testing.T) {
	c := newCache()
	for _, b := range []store.Block{
		toolBlock(1),     // 有短正文
		longBodyBlock(2), // 折叠
		func() store.Block { b := longBodyBlock(3); b.Expanded = true; return b }(),
		{ID: "empty", Kind: store.KindAssistant, Version: 1}, // 空正文
	} {
		rendered := c.Block(b, 80, b.Live)
		want := 1 + strings.Count(rendered, "\n")
		if got := c.Height(b, 80); got != want {
			t.Fatalf("%q 的高度 %d 与实渲染 %d 行不一致", b.ID, got, want)
		}
	}
}

func TestHeightCachedPerTuple(t *testing.T) {
	c := newCache()
	b := longBodyBlock(1)

	c.Height(b, 80)
	c.Height(b, 80)
	if got := c.Estimates(); got != 1 {
		t.Fatalf("同一 (version,width,expanded) 第二次应命中缓存，实际估算 %d 次", got)
	}

	c.Height(b, 81) // 宽度变了
	if got := c.Estimates(); got != 2 {
		t.Fatalf("宽度变化应重算高度，实际估算 %d 次", got)
	}

	b.Version = 2 // 版本变了
	c.Height(b, 81)
	if got := c.Estimates(); got != 3 {
		t.Fatalf("版本变化应重算高度，实际估算 %d 次", got)
	}

	b.Expanded = true // 折叠态变了
	if h := c.Height(b, 81); h != 21 {
		t.Fatalf("展开态高度应为 21 行（工具块无留白 + 块头 + 20 行正文），实际 %d", h)
	}
	if got := c.Estimates(); got != 4 {
		t.Fatalf("展开态变化应重算高度，实际估算 %d 次", got)
	}
}

func TestHeightDoesNotRenderOffscreenBlocks(t *testing.T) {
	c := newCache()
	b := longBodyBlock(1)
	c.Height(b, 80)
	if got := c.Renders(); got != 0 {
		t.Fatalf("量高度不该触发渲染（虚拟滚动的省法就在这），实际渲染 %d 次", got)
	}
}

func TestHeightBackfilledByRender(t *testing.T) {
	c := newCache()
	b := longBodyBlock(1)
	// 先估算（可能因宽字符边界有偏差），渲染后被回填成精确值。
	estimate := c.Height(b, 80)
	rendered := c.Block(b, 80, false)
	exact := 1 + strings.Count(rendered, "\n")
	if got := c.Height(b, 80); got != exact {
		t.Fatalf("渲染后高度应回填为精确值 %d（估算 %d），实际 %d", exact, estimate, got)
	}
}

func TestAssistantMarkdownIsLight(t *testing.T) {
	c := newCache()
	b := store.Block{
		ID: "a:1", Kind: store.KindAssistant, Version: 1, Expanded: true,
		Body: "## 扫描结果\n\n- `22/tcp` ssh **超时**\n- 80/tcp 正常\n\n```bash\nnmap -sV\n```\n\n> 先修 ssh",
	}
	out := c.Block(b, 80, false)
	// 围栏行保留反引号（它是代码块边界）；行内代码 / 加粗 / 标题 / 引用标记去掉。
	for _, gone := range []string{"## ", "**", "`22/tcp`", "> "} {
		if strings.Contains(out, gone) {
			t.Fatalf("标记 %q 应被去掉：\n%s", gone, out)
		}
	}
	for _, want := range []string{"扫描结果", "• 22/tcp ssh 超时", "• 80/tcp 正常", "│ 先修 ssh"} {
		if !strings.Contains(out, want) {
			t.Fatalf("缺少 %q：\n%s", want, out)
		}
	}
}

// 标题/列表去掉标记会变窄，但绝不能变宽——宽了就会把折行算错。
func TestAssistantMarkdownNeverWidens(t *testing.T) {
	for _, line := range []string{"## 标题", "- item", "> quote", "`code`", "**bold**"} {
		inCode := false
		out := styleMarkdownLine(line, &inCode)
		if got, want := lipgloss.Width(out), lipgloss.Width(line); got > want {
			t.Fatalf("%q 渲染后变宽：%d > %d", line, got, want)
		}
	}
}

// 助手正文永远完整显示：总结被截成 6 行 + "Alt+r 展开" 是最刺眼的一条反馈。
func TestAssistantBodyNeverFolds(t *testing.T) {
	c := newCache()
	body := strings.Repeat("结论一行\n", 20)
	b := store.Block{ID: "a:2", Kind: store.KindAssistant, Version: 1, Body: body}
	out := c.Block(b, 80, false)
	if strings.Contains(out, "Alt+r 展开") {
		t.Fatalf("助手正文不该出现折叠提示：\n%s", out)
	}
	if got := strings.Count(out, "结论一行"); got != 20 {
		t.Fatalf("应完整显示 20 行，实际 %d", got)
	}
}

// 工具输出仍然折叠：日志型内容不该占满屏幕。
func TestToolOutputStillFolds(t *testing.T) {
	c := newCache()
	body := strings.Repeat("log line\n", 20)
	b := store.Block{ID: "tool:z", Kind: store.KindTool, Version: 1, Body: body}
	out := c.Block(b, 80, false)
	if !strings.Contains(out, "（Alt+r）") {
		t.Fatalf("工具输出应折叠：\n%s", out)
	}
	if got := strings.Count(out, "log line"); got != 1 {
		t.Fatalf("折叠后正文应全部隐藏（仅块头摘要 1 行），实际 %d", got)
	}
}

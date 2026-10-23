// Command zhishi-tui 是 zhishi 的终端前端（M0 walking skeleton）。
//
// 形态：只跟 sidecar 讲 JSON（HTTP + SSE），不做任何业务逻辑——会话、turn、
// 工具全由 sidecar 的 loop 引擎负责，前端只负责把事件画成人能看的东西。
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/app"
	"github.com/lielingai/zhishi/tui/internal/client"
	"github.com/lielingai/zhishi/tui/internal/protocol"
	"github.com/lielingai/zhishi/tui/internal/render"
	"github.com/lielingai/zhishi/tui/internal/store"
)

// probeWindow 是探针的采样窗口。够长到覆盖 chat:init + 冷历史重放 +
// 一次 send 的往返，又短到能在 CI/脚本里跑。
const probeWindow = 3 * time.Second

func main() {
	server := flag.String("server", client.DefaultServer, "sidecar 地址")
	token := flag.String("token", os.Getenv("ZHISHI_TOKEN"), "sidecar 鉴权 token（缺省取 $ZHISHI_TOKEN）")
	probe := flag.Bool("probe", false, "非 TTY 自检：连 sidecar、订阅 SSE 3 秒、打印事件计数后退出")
	probeOverlays := flag.Bool("probe-overlays", false,
		"非 TTY 自检：把四个数据覆盖层各打开一次，打印条数与首条后退出")
	probeM2b := flag.Bool("probe-m2b", false,
		"非 TTY 自检：拉一次 /sessions 与 wire 消息，走只读回看路径后退出")
	probeCLI := flag.String("probe-cli", "",
		"非 TTY 自检：把一条 /命令 走完整路径跑一次并打印输出（例：--probe-cli \"/model list\"）")
	flag.Parse()

	c := client.New(*server, *token)
	if *probeCLI != "" {
		out, ok, err := app.ProbeCLI(*server, *token, *probeCLI)
		if err != nil {
			fmt.Fprintf(os.Stderr, "probe-cli 失败: %v\n", err)
			os.Exit(1)
		}
		fmt.Print(out)
		if !strings.HasSuffix(out, "\n") {
			fmt.Println()
		}
		if !ok {
			os.Exit(1)
		}
		return
	}
	if *probeM2b {
		if err := runM2bProbe(c, *server); err != nil {
			fmt.Fprintf(os.Stderr, "m2b probe 失败: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if *probeOverlays {
		if err := runOverlayProbe(c, *server); err != nil {
			fmt.Fprintf(os.Stderr, "overlay probe 失败: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if *probe {
		if err := runProbe(c, *server); err != nil {
			fmt.Fprintf(os.Stderr, "probe 失败: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if err := runTUI(c, *server); err != nil {
		fmt.Fprintf(os.Stderr, "zhishi-tui: %v\n", err)
		os.Exit(1)
	}
}

// runTUI 起 bubbletea 主循环。
func runTUI(c *client.Client, server string) error {
	// 每次启动清空鼠标诊断日志：一次会话一份，读的时候不会混。
	_ = os.Remove(app.MouseDebugPath())
	m := app.NewModel(server, c)
	// 退出时Cancel 掉 ctx：SSE 长连接与在途请求一起收尾，不留孤儿 goroutine。
	defer m.Cancel()

	// 默认**不**上报鼠标：终端原生拖选开箱即用。滚轮不会因此失灵——Windows
	// Terminal 在 alt-screen 下把滚轮翻译成 ↑↓，Update 里空输入时借给 stream
	// 滚动。需要点块头折叠时按 F2 / Alt+m 接管（运行时可逆）。
	p := tea.NewProgram(app.New(m), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		return err
	}
	return nil
}

// runProbe 是非 TTY 环境下的端到端自检。
//
// 它刻意复用真实前端的归约器（app.Model.Update）而不是另写一套解析：
// 探针打出来的东西如果和 TUI 里看到的对不上，那就是前端 bug——这正是
// 这个模式存在的意义（本仓库所在环境没有 TTY）。
func runProbe(c *client.Client, server string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if err := c.Health(ctx); err != nil {
		return fmt.Errorf("GET /health: %w", err)
	}
	fmt.Printf("health    ok  %s\n", server)

	sub, err := c.Subscribe(ctx)
	if err != nil {
		return fmt.Errorf("GET /chat/stream: %w", err)
	}
	defer sub.Close()
	fmt.Println("stream    已订阅 /chat/stream")

	// 光订阅只能看到 chat:init / 冷历史重放；要拿到 turn 事件必须发一条。
	// 失败（无 provider key 等）不影响探针结论——错误本身也是 SSE 事件。
	sent := make(chan error, 1)
	go func() {
		res, err := c.Send(ctx, "probe: zhishi-tui M0 walking skeleton", client.SendOptions{})
		switch {
		case err != nil:
			sent <- err
		case !res.Success:
			sent <- fmt.Errorf("%s", res.Error)
		default:
			sent <- nil
		}
	}()

	m := app.NewModel(server, c)
	counts := make(map[protocol.Kind]int)
	var firstEvent protocol.Kind

	deadline := time.After(probeWindow)
loop:
	for {
		select {
		case ev, ok := <-sub.Events:
			if !ok {
				break loop
			}
			if firstEvent == "" {
				firstEvent = ev.Kind
			}
			counts[ev.Kind]++
			// 忽略返回的 Cmd：探针没有消息循环，只借归约逻辑。
			m, _ = m.Update(app.EventMsg(ev))
		case <-deadline:
			break loop
		}
	}

	fmt.Printf("window    %s\n", probeWindow)
	select {
	case err := <-sent:
		if err != nil {
			fmt.Printf("send      POST /chat/send 未受理: %v\n", err)
		} else {
			fmt.Println("send      POST /chat/send 已受理")
		}
	default:
		fmt.Println("send      POST /chat/send 仍未返回（窗口内未完成）")
	}

	fmt.Println("\n事件计数:")
	if len(counts) == 0 {
		fmt.Println("  （一个事件都没收到）")
	}
	kinds := make([]protocol.Kind, 0, len(counts))
	for k := range counts {
		kinds = append(kinds, k)
	}
	sort.Slice(kinds, func(i, j int) bool { return kinds[i] < kinds[j] })
	for _, k := range kinds {
		fmt.Printf("  %-28s %d\n", string(k), counts[k])
	}
	if firstEvent != "" {
		fmt.Printf("首帧事件: %s\n", firstEvent)
	}
	fmt.Printf("会话态: %s\n", m.SessionSt)

	blocks := m.VisibleBlocks()
	fmt.Printf("\n块数: %d\n", len(blocks))
	if len(blocks) == 0 {
		return nil
	}
	limit := len(blocks)
	if limit > 8 {
		limit = 8
	}
	for i := 0; i < limit; i++ {
		b := blocks[i]
		fmt.Printf("  #%d id=%s kind=%s title=%q failed=%v live=%v expanded=%v body=%q\n",
			i, b.ID, b.Kind, b.Title, b.Failed, b.Live, b.Expanded, truncate(b.Body, 60))
	}
	b := blocks[0]
	fmt.Printf("\n首个块: id=%s kind=%s title=%q failed=%v live=%v\n",
		b.ID, b.Kind, b.Title, b.Failed, b.Live)
	fmt.Printf("\n渲染首个块（宽 100）:\n%s\n", render.NewCache().Block(b, 100, b.Live))

	// 工具块单独看一眼：折叠行数与省略提示是 M1 的行为，值得在探针里留证据。
	for _, cand := range blocks {
		if cand.Kind == store.KindTool {
			fmt.Printf("\n渲染工具块（宽 100，折叠态）:\n%s\n",
				render.NewCache().Block(cand, 100, cand.Live))
			break
		}
	}

	// 走一遍真实 View（含虚拟滚动窗口 + 状态行），确认归约链没被折叠/滚动改坏。
	frame := m.View()
	lines := strings.Split(frame, "\n")
	fmt.Printf("\n画面: %d 行（%d 列的默认尺寸）\n", len(lines), m.Width)
	from := len(lines) - 6
	if from < 0 {
		from = 0
	}
	fmt.Printf("--- 画面尾部 ---\n%s\n---\n", strings.Join(lines[from:], "\n"))
	return nil
}

// runM2bProbe 验的是两条只读链路：GET /sessions 与 wire 回看。
//
// attach 不在这里跑：它要接管真终端（raw mode + 全屏），管道里没有终端可
// 接管，跑了也证明不了什么。这一行明文写出来，免得看输出的人以为漏了。
func runM2bProbe(c *client.Client, server string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := c.Health(ctx); err != nil {
		return fmt.Errorf("GET /health: %w", err)
	}
	fmt.Printf("health    ok  %s\n", server)

	sessions, err := c.Sessions(ctx)
	if err != nil {
		return fmt.Errorf("GET /sessions: %w", err)
	}
	fmt.Printf("sessions  %d 条\n", len(sessions))
	if len(sessions) > 0 {
		s := sessions[0]
		fmt.Printf("          首条: id=%s title=%q loopSessionId=%q lastActiveAt=%s 消息=%d\n",
			s.ID, s.Title, s.LoopSessionID, s.LastActiveAt, s.MessageCount())
	}

	// 走真实覆盖层路径：Alt+h → Enter → 只读回看层。
	// 这样最后那个"块数"是归约器真跑出来的，不是探针自己数出来的。
	m := app.NewModel(server, c)
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'h'}, Alt: true})
	m = drain(m, cmd)
	if ov, ok := m.TopOverlay(); ok {
		sm := ov.Summary()
		fmt.Printf("history   %s 条数=%d 首条=%q\n", sm.State, sm.Count, sm.First)
	}
	if len(sessions) > 0 {
		m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
		m = drain(m, cmd)
		if ov, ok := m.TopOverlay(); ok {
			sm := ov.Summary()
			fmt.Printf("replay    kind=%s state=%s 块数=%d 首条=%q\n",
				sm.Kind, sm.State, sm.Count, sm.First)
			if sm.Err != "" {
				fmt.Printf("          err: %s\n", sm.Err)
			}
		}
	}

	// 直连一次的原始数字（不经覆盖层），便于和上面的块数对账。
	if len(sessions) > 0 && sessions[0].LoopSessionID != "" {
		page, err := c.WireMessages(ctx, sessions[0].LoopSessionID)
		if err != nil {
			fmt.Printf("wire      拉取失败: %v\n", err)
		} else {
			fmt.Printf("wire      messages=%d total=%d truncated=%v\n",
				len(page.Messages), page.Total, page.Truncated)
		}
	}

	fmt.Println("attach    需真终端，已跳过")
	return nil
}

// overlayProbeSteps 是四个覆盖层的打开键（顺序 = 设计稿的 Alt+e/l/t/a）。
var overlayProbeSteps = []struct {
	label string
	key   tea.KeyMsg
}{
	{"环境 Alt+e", tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'e'}, Alt: true}},
	{"线   Alt+l", tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'l'}, Alt: true}},
	{"任务 Alt+t", tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'t'}, Alt: true}},
	{"档案 Alt+a", tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}, Alt: true}},
}

// runOverlayProbe 在非 TTY 下把四个覆盖层各打开一次。
//
// 它走的是真实路径：按键 → Route 三段式 → 覆盖层 Handle → Cmd → 结果归约。
// 唯一"假"的地方是手动驱动消息循环（drain）——真实 UI 里由 bubbletea 做。
func runOverlayProbe(c *client.Client, server string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if err := c.Health(ctx); err != nil {
		return fmt.Errorf("GET /health: %w", err)
	}
	fmt.Printf("health    ok  %s\n", server)

	m := app.NewModel(server, c)
	// workspace/sessionId 由 chat:init 提供；探针不订阅 SSE，这里留空，
	// 档案请求就走服务端的"当前线"缺省语义。
	fmt.Printf("%-14s %-8s %-5s %s\n", "覆盖层", "状态", "条数", "首条")
	for _, step := range overlayProbeSteps {
		m, cmd := m.Update(step.key)
		m = drain(m, cmd)
		ov, ok := m.TopOverlay()
		if !ok {
			fmt.Printf("%-14s %s\n", step.label, "没有打开（栈为空）")
			continue
		}
		s := ov.Summary()
		fmt.Printf("%-14s %-8s %-5d %s\n", step.label, s.State, s.Count, s.First)
		if s.Err != "" {
			fmt.Printf("%-14s   err: %s\n", "", s.Err)
		}
		// 关掉这一层再开下一个，避免叠成一摞。
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	}
	return nil
}

// drain 把一条命令链跑完：执行 Cmd → 结果喂回归约器 → 继续，直到没有新命令。
func drain(m app.Model, cmd tea.Cmd) app.Model {
	for i := 0; cmd != nil && i < 8; i++ {
		msg := cmd()
		if msg == nil {
			break
		}
		m, cmd = m.Update(msg)
	}
	return m
}

func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

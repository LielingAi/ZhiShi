// framegen 生成一张真实 TUI 帧（README 截图用）。
//
// 只在需要更新 README 图片时手动跑：
//
//	CLICOLOR_FORCE=1 go run ./cmd/framegen > frame.ansi
//
// 它构造一个与实机等价的 Model（同样的 NewModel / layout / View），不连 sidecar。
package main

import (
	"fmt"
	"os"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"

	"github.com/lielingai/zhishi/tui/internal/app"
	"github.com/lielingai/zhishi/tui/internal/store"
)

func main() {
	// 管道输出时 lipgloss 默认降级为无色；README 截图要的是终端里真实看到的配色。
	lipgloss.SetColorProfile(termenv.TrueColor)
	m := app.NewModel("http://127.0.0.1:7411", nil)
	m.Width, m.Height = 104, 26
	m.Connected = true
	m.SessionID = "mvk7yq8m-6796f113e573"
	m.SessionTitle = "ret2win 复现"
	m.SessionSt = "idle"
	m.ModelID = "deepseek-flash"
	m.ContextUsed = 128000
	m.ContextWindow = 250000
	m.UsageTokens = 42400
	// layout() 只做输入框尺寸（不导出），这里等价复刻：内容宽 = 总宽 - 左边距 1 - 边框 2 - 内边距 2。
	m.Input.SetWidth(m.Width - 5)
	m.Input.SetHeight(m.InputLines())

	blocks := []store.Block{
		{ID: "u1", Kind: store.KindUser, Version: 1, Body: "分析 /home/researcher/ret2win/vuln，gets 溢出，打通拿 flag"},
		{ID: "a1", Kind: store.KindAssistant, Version: 1, Body: "先确认保护与溢出偏移。"},
		{ID: "t1", Kind: store.KindTool, Title: "env_exec", Version: 1, Duration: 320 * time.Millisecond, Body: "exit=0\n--- stdout ---\nArch:     amd64-64-little\nRELRO:    Partial RELRO\nStack:    No canary found\nNX:       NX enabled\nPIE:      No PIE (0x400000)\nFORTIFY:  Enabled\n--- stderr ---\n"},
		{ID: "a2", Kind: store.KindAssistant, Version: 1, Body: "偏移 72（cyclic + core 确认）。垫一个 ret 对齐 movaps，跳 win。"},
		{ID: "t2", Kind: store.KindTool, Title: "env_exec", Version: 1, Duration: 1*time.Second + 180*time.Millisecond, Body: "exit=0\n--- stdout ---\n[*] offset = 72\n[*] ret    = 0x40101a\n[*] win    = 0x401196\nflag{ret2win_pwned_successfully}\n"},
		{ID: "a3", Kind: store.KindAssistant, Version: 1, Body: "已拿到 flag：偏移 72，ret 对齐后跳 0x401196。\nPoC 在 /home/researcher/ret2win/exp.py，可重复复现。"},
	}
	for _, b := range blocks {
		m.Store.Upsert(b)
	}

	os.Stdout.WriteString(m.View())
	fmt.Fprintln(os.Stdout)
}

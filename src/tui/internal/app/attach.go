package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"golang.org/x/term"

	"github.com/lielingai/zhishi/tui/internal/client"
)

// Ctrl-] 是 attach 的退出键。
//
// 不用 Ctrl-C：attach 是"接管远端 shell"，Ctrl-C 必须原样透传给远端——本地
// 抢走它会让 vim/less 里的中断行为跟远端不一致（用户在远端按 Ctrl-C 却发现
// 自己掉出了 attach 是最坏的体验）。
const (
	exitKeyByte   = 0x1d // Ctrl-]
	exitKeyWindow = 2 * time.Second
	exitKeyHint   = "再按一次 Ctrl-] 退出 attach"
)

// 远端 pty 的默认尺寸（term-pty.ts::DEFAULT_COLS/ROWS）。拿不到本地尺寸时
// 用它，免得发 0x0 把远端 pty 撑坏。
const (
	defaultCols = 80
	defaultRows = 24
)

// errDetached 表示用户自己按了两次 Ctrl-]（不是远端退出，也不是故障）。
var errDetached = errors.New("attach: detached by user")

// frameConn 是字节泵需要的全部连接能力。
//
// *client.TermConn 结构上满足它；测试注入假实现，完全不起网络。
type frameConn interface {
	Send(ctx context.Context, frame []byte) error
	Recv(ctx context.Context) ([]byte, error)
	Close() error
}

// attachOpts 是字节泵的全部依赖。时钟与尺寸都注入，泵本身不碰 os。
type attachOpts struct {
	Ctx  context.Context
	In   io.Reader
	Out  io.Writer
	Conn frameConn
	// Size 返回当前终端尺寸；Resizes 每来一个信号就复查一次（生产是定时器）。
	Size    func() (cols, rows int)
	Resizes <-chan struct{}
	// Now 注入时钟：二次 Ctrl-] 的 2 秒窗口必须可测。
	Now func() time.Time
}

// runAttachPump 是 attach 的字节泵：本地输入 → input 帧，output 帧 → 本地输出。
//
// 返回 (code, err) 三种收尾：
//   - 远端 exit 帧 → (code, nil)
//   - 用户两次 Ctrl-] → (-1, errDetached)
//   - 远端 error 帧 / 连接断开 → (-1, 对应错误)
//
// 只有一个 goroutine 发帧（主循环）：输入与收到的帧都经 channel 汇进来，
// 省掉锁，也让"Ctrl-] 判定"与"发送"天然串行（不会出现半帧插队）。
func runAttachPump(opts attachOpts) (int, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Size == nil {
		opts.Size = func() (int, int) { return defaultCols, defaultRows }
	}
	ctx := opts.Ctx
	if ctx == nil {
		ctx = context.Background()
	}

	// 进入时先同步一次尺寸：远端 pty 初始是 80x24，不先对齐 vim/top 会错位。
	lastCols, lastRows := clampSize(opts.Size())
	if err := sendFrame(ctx, opts.Conn, client.TermFrame{Type: "resize", Cols: lastCols, Rows: lastRows}); err != nil {
		return -1, err
	}

	// 输入侧：Read 不能 select，只能放 goroutine。
	inCh := make(chan []byte, 8)
	go func() {
		defer close(inCh)
		buf := make([]byte, 4096)
		for {
			n, err := opts.In.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				select {
				case inCh <- chunk:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// 接收侧：同理，Recv 是阻塞的。
	frameCh := make(chan []byte, 8)
	recvErrCh := make(chan error, 1)
	go func() {
		defer close(frameCh)
		for {
			data, err := opts.Conn.Recv(ctx)
			if err != nil {
				select {
				case recvErrCh <- err:
				default:
				}
				return
			}
			select {
			case frameCh <- data:
			case <-ctx.Done():
				return
			}
		}
	}()

	var lastExitKey time.Time
	for {
		select {
		case <-ctx.Done():
			return -1, ctx.Err()

		case chunk, ok := <-inCh:
			if !ok {
				inCh = nil // 输入断了（stdin 关闭）：继续收远端，不结束
				continue
			}
			data, hint, quit := splitExitKey(chunk, &lastExitKey, opts.Now())
			if hint {
				// raw 模式下换行要显式 \r\n，否则提示会粘在远端输出后面。
				_, _ = io.WriteString(opts.Out, "\r\n["+exitKeyHint+"]\r\n")
			}
			if quit {
				return -1, errDetached
			}
			if len(data) > 0 {
				if err := sendFrame(ctx, opts.Conn, client.TermFrame{
					Type: "input", Data: string(data),
				}); err != nil {
					return -1, err
				}
			}

		case <-opts.Resizes:
			cols, rows := clampSize(opts.Size())
			if cols == lastCols && rows == lastRows {
				continue // 尺寸没变，不打扰远端
			}
			lastCols, lastRows = cols, rows
			if err := sendFrame(ctx, opts.Conn, client.TermFrame{
				Type: "resize", Cols: cols, Rows: rows,
			}); err != nil {
				return -1, err
			}

		case data, ok := <-frameCh:
			if !ok {
				// 连接结束：优先报真实原因。
				select {
				case err := <-recvErrCh:
					return -1, err
				default:
					return -1, io.EOF
				}
			}
			var fr client.TermFrame
			if err := json.Unmarshal(data, &fr); err != nil {
				continue // 不认识的帧不值得掐断整条 attach
			}
			switch fr.Type {
			case "output":
				if _, err := io.WriteString(opts.Out, fr.Data); err != nil {
					return -1, err
				}
			case "exit":
				return fr.Code, nil
			case "error":
				return -1, fmt.Errorf("%s", fr.Message)
			case "pong":
				// 心跳回执：不需要动作。
			}
		}
	}
}

// splitExitKey 从输入块里摘掉 Ctrl-]，并判定是否该退出。
//
// 返回 (转发给远端的字节, 是否要提示, 是否退出)。单个 Ctrl-] 只提示不退出：
// attach 里 Ctrl-] 常用于跳转（readline 的 ctrl-] 是字符查找），误触一次就
// 掉线太粗暴。
func splitExitKey(chunk []byte, lastPress *time.Time, now time.Time) (data []byte, hint, quit bool) {
	out := make([]byte, 0, len(chunk))
	for _, b := range chunk {
		if b != exitKeyByte {
			out = append(out, b)
			continue
		}
		if !lastPress.IsZero() && now.Sub(*lastPress) <= exitKeyWindow {
			return out, false, true
		}
		*lastPress = now
		hint = true
	}
	return out, hint, quit
}

func clampSize(cols, rows int) (int, int) {
	if cols <= 0 {
		cols = defaultCols
	}
	if rows <= 0 {
		rows = defaultRows
	}
	return cols, rows
}

func sendFrame(ctx context.Context, conn frameConn, fr client.TermFrame) error {
	return conn.Send(ctx, fr.JSON())
}

// ── attach 的终端接管 ───────────────────────────────────────────────────

// attachDoneMsg 是 attach 结束的回执（结果落到状态行，不直接写终端）。
type attachDoneMsg struct {
	envID string
	code  int
	err   error
}

// attachExec 是 tea.Exec 的执行体：整个 attach 生命期都在 Run 里。
//
// 用 tea.Exec 而不是 tea.ExecProcess：这里没有子进程可起——"进程"就是 WS 泵。
// ExecProcess 只是 Exec + exec.Cmd 的语法糖，机制完全一样（bubbletea 先
// ReleaseTerminal 放出终端，Run 返回后 RestoreTerminal 重绘）。
type attachExec struct {
	client *client.Client
	envID  string
	ctx    context.Context

	in  io.Reader
	out io.Writer

	res *attachOutcome
}

// attachOutcome 是 Run 的结论，回调读它转成 attachDoneMsg。
type attachOutcome struct {
	code int
	err  error
}

func (a *attachExec) SetStdin(r io.Reader)  { a.in = r }
func (a *attachExec) SetStdout(w io.Writer) { a.out = w }
func (a *attachExec) SetStderr(io.Writer)   {}

func (a *attachExec) Run() error {
	if a.in == nil {
		a.in = os.Stdin
	}
	if a.out == nil {
		a.out = os.Stdout
	}

	// raw mode：拿不到终端（管道/CI）就跳过——泵本身不需要 raw，raw 只是
	// 让按键不被本地行缓冲吃掉。
	if restore := makeRaw(a.in); restore != nil {
		defer restore()
	}

	conn, err := a.client.DialTerm(a.ctx, a.envID)
	if err != nil {
		a.res = &attachOutcome{code: -1, err: err}
		return nil // 不把 err 交回 bubbletea：它对 err 的处理是"程序出错"
	}
	defer func() { _ = conn.Close() }()

	resizes, stop := pollResizes(a.ctx)
	defer stop()

	code, perr := runAttachPump(attachOpts{
		Ctx:     a.ctx,
		In:      a.in,
		Out:     a.out,
		Conn:    conn,
		Size:    termSize(a.in, a.out),
		Resizes: resizes,
	})
	a.res = &attachOutcome{code: code, err: perr}
	return nil
}

// makeRaw 把终端切到 raw，返回恢复函数；不是终端时返回 nil。
//
// 恢复必须由调用方 defer——attach 中途 panic 也不能把用户终端留在 raw 里。
func makeRaw(in io.Reader) func() {
	f, ok := in.(*os.File)
	if !ok {
		return nil
	}
	fd := int(f.Fd())
	if !term.IsTerminal(fd) {
		return nil
	}
	state, err := term.MakeRaw(fd)
	if err != nil {
		return nil
	}
	return func() { _ = term.Restore(fd, state) }
}

// termSize 从输出/输入 fd 读终端尺寸（Windows 上 GetSize 走控制台 API）。
func termSize(in io.Reader, out io.Writer) func() (int, int) {
	return func() (int, int) {
		for _, cand := range []any{out, in} {
			f, ok := cand.(*os.File)
			if !ok {
				continue
			}
			if cols, rows, err := term.GetSize(int(f.Fd())); err == nil && cols > 0 && rows > 0 {
				return cols, rows
			}
		}
		return defaultCols, defaultRows
	}
}

// pollResizes 每 500ms 触发一次尺寸复查。
//
// 跨平台考虑：Unix 有 SIGWINCH，Windows 没有，所以统一轮询。500ms 的延迟
// 对"拖窗口"这种低频动作够用，代价可以忽略。
func pollResizes(ctx context.Context) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	done := make(chan struct{})
	stop := func() {
		select {
		case <-done:
		default:
			close(done)
		}
	}
	go func() {
		t := time.NewTicker(500 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				select {
				case ch <- struct{}{}:
				default:
				}
			}
		}
	}()
	return ch, stop
}

// attachCmd 借终端跑 attach。结束后由 update 把结果落到状态行。
func attachCmd(ctx context.Context, c *client.Client, envID string) tea.Cmd {
	if c == nil {
		return noticeCmd("attach 不可用：没有 sidecar 客户端")
	}
	if envID == "" {
		return noticeCmd("attach 需要先选一个环境（Alt+e 选，或先切环境）")
	}
	ex := &attachExec{client: c, envID: envID, ctx: ctx}
	return tea.Exec(ex, func(err error) tea.Msg {
		out := ex.res
		if out == nil {
			out = &attachOutcome{code: -1, err: err}
		}
		if err != nil && out.err == nil {
			out.err = err
		}
		return attachDoneMsg{envID: envID, code: out.code, err: out.err}
	})
}

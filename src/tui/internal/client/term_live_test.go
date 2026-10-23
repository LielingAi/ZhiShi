package client

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// TestTermDialLive 是**可选的真服务端**测试：只有设置了
// ZHISHI_LIVE_ATTACH=http://127.0.0.1:<port> 才跑。
//
// 为什么要它：attach 的 WS 契约（upgrade 是否接受、query token、帧形状、
// input 是否真进到 pty）在无 TTY 的环境里没法靠 UI 验，但**连接本身**不需要
// 终端——只有 raw mode 和全屏接管需要。所以把"连接 + 双向帧"单独验掉，
// 剩下的终端部分如实标注为"只能在真终端验"。
//
// 默认跳过：CI 里没有 sidecar，这个测试不该把 `go test ./...` 拖红。
func TestTermDialLive(t *testing.T) {
	base := os.Getenv("ZHISHI_LIVE_ATTACH")
	if base == "" {
		t.Skip("设置 ZHISHI_LIVE_ATTACH=http://127.0.0.1:<port> 才跑（需要真 sidecar）")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	c := New(base, "")
	conn, err := c.DialTerm(ctx, "local")
	if err != nil {
		t.Fatalf("DialTerm 失败：%v", err)
	}
	defer conn.Close()

	var sawOutput bool
	for i := 0; i < 3; i++ {
		data, err := conn.Recv(ctx)
		if err != nil {
			break
		}
		var fr TermFrame
		if err := json.Unmarshal(data, &fr); err != nil {
			t.Fatalf("帧不是合法 JSON：%s", data)
		}
		switch fr.Type {
		case "output":
			sawOutput = true
		case "error":
			// spawn 失败（缺原生 pty 模块）也是有效答复：说明协议通了。
			t.Logf("服务端回 error 帧（协议可用，环境不可 spawn）：%s", fr.Message)
			return
		case "exit":
			t.Logf("服务端直接 exit，code=%d", fr.Code)
			return
		}
	}
	if !sawOutput {
		t.Fatal("没收到任何 output 帧（upgrade 或帧形状可能不对）")
	}

	// 输入方向：让远端回显一个标记，证明 input 帧真的进了 pty。
	if err := conn.Send(ctx, TermFrame{Type: "input", Data: "echo zhishi-attach-ok\r"}.JSON()); err != nil {
		t.Fatalf("发 input 失败：%v", err)
	}
	if err := conn.Send(ctx, TermFrame{Type: "resize", Cols: 100, Rows: 30}.JSON()); err != nil {
		t.Fatalf("发 resize 失败：%v", err)
	}
	for {
		data, err := conn.Recv(ctx)
		if err != nil {
			t.Fatalf("等回显时连接断了：%v", err)
		}
		if strings.Contains(string(data), "zhishi-attach-ok") {
			return
		}
	}
}

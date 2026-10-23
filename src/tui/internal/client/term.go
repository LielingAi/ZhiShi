package client

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/coder/websocket"
)

// TermWSPath 是 attach 的 WS 路径（src/server/loop/term-pty.ts::TERM_WS_PATH）。
const TermWSPath = "/api/admin/environment/term"

// TermConn 是 attach 的帧通道。
//
// 只暴露 Send/Recv/Close 三个动作：app 侧的字节泵需要的就这些，多了就是把
// 传输层细节漏进 UI。测试用一个假实现替换它，不碰真网络。
type TermConn struct {
	conn *websocket.Conn
}

// DialTerm 连上某个环境的 pty。
//
// token 走 `?token=` query（WS upgrade 认 query 兜底，见 auth/gate.ts 的
// queryToken——这是 HTTP 路径不认、WS 路径认的那个例外）+ Authorization 头，
// 两条都发：服务端优先头，浏览器类客户端只能 query。
func (c *Client) DialTerm(ctx context.Context, envID string) (*TermConn, error) {
	if strings.TrimSpace(envID) == "" {
		return nil, fmt.Errorf("attach 需要环境 id")
	}
	endpoint, header := termEndpoint(c.BaseURL, c.Token, envID)
	opts := &websocket.DialOptions{HTTPClient: c.HTTP, HTTPHeader: header}
	conn, resp, err := websocket.Dial(ctx, endpoint, opts)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("attach 连接失败：HTTP %d（%w）", resp.StatusCode, err)
		}
		return nil, fmt.Errorf("attach 连接失败：%w", err)
	}
	return &TermConn{conn: conn}, nil
}

// termEndpoint 拼 attach 的 WS 地址与鉴权头。
//
// 抽成纯函数是为了可测：scheme 要 http→ws / https→wss、env 与 token 都要
// 转义、token 为空时不能带 Authorization 头（本机模式没有 token）。
func termEndpoint(base, token, envID string) (string, map[string][]string) {
	// 末尾斜杠必须去掉：拼出来会是 //api/admin/...，服务端按 pathname 精确
	// 匹配 TERM_WS_PATH，多一个斜杠就直接 destroy 掉这次 upgrade。
	base = strings.TrimRight(base, "/")
	base = strings.Replace(base, "https://", "wss://", 1)
	base = strings.Replace(base, "http://", "ws://", 1)

	q := url.Values{}
	q.Set("env", envID)
	if token != "" {
		q.Set("token", token)
	}
	var header map[string][]string
	if token != "" {
		header = map[string][]string{"Authorization": {"Bearer " + token}}
	}
	return base + TermWSPath + "?" + q.Encode(), header
}

// Send 发一帧（JSON 文本帧，协议见 term-pty.ts 头注释）。
func (t *TermConn) Send(ctx context.Context, frame []byte) error {
	return t.conn.Write(ctx, websocket.MessageText, frame)
}

// Recv 收一帧。返回的字节是原始 JSON，由调用方按需解码。
func (t *TermConn) Recv(ctx context.Context) ([]byte, error) {
	_, data, err := t.conn.Read(ctx)
	return data, err
}

// Close 正常关闭（服务端只看 WS close 来回收 pty）。
func (t *TermConn) Close() error {
	return t.conn.Close(websocket.StatusNormalClosure, "")
}

// ── 帧编码 ──────────────────────────────────────────────────────────────

// TermFrame 同时覆盖两个方向的帧：一个结构够用，未用字段留零值不进 JSON。
type TermFrame struct {
	Type    string `json:"type"`
	Data    string `json:"data,omitempty"`
	Cols    int    `json:"cols,omitempty"`
	Rows    int    `json:"rows,omitempty"`
	Code    int    `json:"code,omitempty"`
	Signal  string `json:"signal,omitempty"`
	Message string `json:"message,omitempty"`
}

// JSON 把帧序列化成线上字节。
func (f TermFrame) JSON() []byte {
	b, err := json.Marshal(f)
	if err != nil {
		// 帧都是纯字符串/数字，Marshal 不可能失败；真失败也只能发个空对象。
		return []byte(`{}`)
	}
	return b
}

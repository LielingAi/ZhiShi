// Package client 是 sidecar 的唯一出口：探活、发消息、中断、订阅 SSE。
//
// 这里不做任何状态归一化——收到帧就往上抛，怎么理解是 app/store 的事。
// 前端只跟 sidecar 讲 JSON，不重复实现业务逻辑。
package client

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lielingai/zhishi/tui/internal/protocol"
)

// DefaultServer 是 sidecar 的默认回环地址（与 Rust sidecar manager 一致）。
const DefaultServer = "http://127.0.0.1:7411"

// Client 是 sidecar 的 HTTP 客户端。零值不可用，用 New 构造。
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// New 构造客户端。token 为空时请求不带 Authorization——auth 关闭的本机模式
// 下这是正常路径（src/server/auth/gate.ts 的 OPEN_VERDICT）。
func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		HTTP: &http.Client{
			// 不带 Timeout：SSE 是长连接，超时由 ctx 控制。
			Transport: http.DefaultTransport,
		},
	}
}

// Health 探活。
func (c *Client) Health(ctx context.Context) error {
	req, err := c.newRequest(ctx, http.MethodGet, "/health", nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health: HTTP %d", resp.StatusCode)
	}
	return nil
}

// SendResult 是 POST /chat/send 的响应（src/server/index.ts 的 /chat/send 分支）。
type SendResult struct {
	Success    bool   `json:"success"`
	Error      string `json:"error"`
	Queued     bool   `json:"queued"`
	IsInFlight bool   `json:"isInFlight"`
	Steering   bool   `json:"steering"`
}

// Send 发一条消息。sidecar 的写闸会回 409 line_not_active / 403 forbidden，
// 这些都以 success=false + error 文本的形式交回上层显示，而不是丢弃。
// ChatRef 是随消息发送的结构化引用（服务端 parseChatRefs 的形状）。
type ChatRef struct {
	Type string `json:"type"` // file / env / snapshot / taskmd
	Path string `json:"path,omitempty"`
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
}

// ChatImage 是随消息发送的图片（base64，无 data URL 前缀）。
type ChatImage struct {
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

// SendOptions 是 /chat/send 的可选字段。
type SendOptions struct {
	// PermissionMode: auto（默认，越界要审批）| fullAgency（后台全自主）。
	PermissionMode string
	Refs           []ChatRef
	Images         []ChatImage
}

func (c *Client) Send(ctx context.Context, text string, opts SendOptions) (SendResult, error) {
	payload := map[string]any{"text": text}
	if opts.PermissionMode != "" {
		payload["permissionMode"] = opts.PermissionMode
	}
	if len(opts.Refs) > 0 {
		payload["refs"] = opts.Refs
	}
	if len(opts.Images) > 0 {
		payload["images"] = opts.Images
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return SendResult{}, err
	}
	req, err := c.newRequest(ctx, http.MethodPost, "/chat/send", bytes.NewReader(body))
	if err != nil {
		return SendResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return SendResult{}, err
	}
	defer resp.Body.Close()
	var out SendResult
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = json.Unmarshal(raw, &out)
	if resp.StatusCode != http.StatusOK {
		if out.Error == "" {
			out.Error = fmt.Sprintf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
		}
		return out, nil
	}
	return out, nil
}

// Stop 中断当前 turn（POST /chat/stop）。
func (c *Client) Stop(ctx context.Context) error {
	req, err := c.newRequest(ctx, http.MethodPost, "/chat/stop", strings.NewReader("{}"))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("stop: HTTP %d", resp.StatusCode)
	}
	return nil
}

// RespondBoundary / RespondDecision 应答「让人选择」的 pending 请求。
//
// 两个端点都在 sidecar 根路径（不在 /api/admin 下），body 形状由服务端定：
//
//	boundary: {askId, approve: bool, note?}
//	decision: {decisionId, choice, note?}
//
// 传 json.RawMessage 而不是 DTO：调用方已经按事件字段拼好了 body。
func (c *Client) RespondBoundary(ctx context.Context, payload json.RawMessage) error {
	return c.postRoot(ctx, "/chat/boundary/respond", payload)
}

func (c *Client) RespondDecision(ctx context.Context, payload json.RawMessage) error {
	return c.postRoot(ctx, "/chat/decision/respond", payload)
}

// postRoot 向 sidecar 根路径 POST 一段 JSON，非 2xx 或 success=false 即报错。
func (c *Client) postRoot(ctx context.Context, path string, payload json.RawMessage) error {
	body := bytes.NewReader(payload)
	req, err := c.newRequest(ctx, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s: HTTP %d %s", path, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var out struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
	}
	if json.Unmarshal(data, &out) == nil && !out.Success && out.Error != "" {
		return fmt.Errorf("%s: %s", path, out.Error)
	}
	return nil
}

// Subscribe 打开 SSE 长连接。
//
// 返回的 Subscription 有两个通道：Events 每帧一个，Err 在流异常结束时最多
// 一个（之后两通道都关闭）。ctx 取消即断开——app 退出时靠它收尾。
//
// token 同时走 header 与 ?token= query：header 是服务端 HTTP 路径唯一认的
// 通道（src/server/auth/gate.ts 的 queryToken 兜底只在 WS upgrade 传），
// query 留着是为了将来把 SSE 挪到不能自定义头的客户端时不用改协议。
func (c *Client) Subscribe(ctx context.Context) (*Subscription, error) {
	endpoint := c.BaseURL + "/chat/stream"
	if c.Token != "" {
		endpoint += "?token=" + url.QueryEscape(c.Token)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	req.Header.Set("Accept", "text/event-stream")
	// SSE 不能用带超时的 client；用独立实例避免 future 的全局 Timeout 影响。
	stream := &http.Client{Transport: c.HTTP.Transport}
	resp, err := stream.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return nil, fmt.Errorf("stream: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	events := make(chan protocol.Event, 256)
	errs := make(chan error, 1)
	sub := &Subscription{Events: events, Errs: errs, close: func() { resp.Body.Close() }}

	go func() {
		defer close(events)
		defer close(errs)
		parser := &protocol.LineParser{}
		scanner := bufio.NewScanner(resp.Body)
		// 单帧可能很大（工具输出），默认 64KiB 行上限不够。
		scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		for scanner.Scan() {
			env, ok := parser.Feed(scanner.Text())
			if !ok {
				continue
			}
			select {
			case events <- protocol.Decode(env):
			case <-ctx.Done():
				return
			}
		}
		if err := scanner.Err(); err != nil && ctx.Err() == nil {
			select {
			case errs <- err:
			default:
			}
		}
	}()

	return sub, nil
}

// Subscription 是一条活着的 SSE 订阅。
type Subscription struct {
	Events <-chan protocol.Event
	Errs   <-chan error
	close  func()
}

// Close 断开。可重复调用（与 ctx 取消重叠时无害）。
func (s *Subscription) Close() {
	if s != nil && s.close != nil {
		s.close()
	}
}

func (c *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return nil, err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	return req, nil
}

// ShortTimeout 给一次性请求（health/send/stop）用的默认预算——sidecar 是
// 本机进程，慢过这个时间基本等于"没起来"。
const ShortTimeout = 5 * time.Second

// ── 会话写操作（2.1 P0）─────────────────────────────────────────────────

// ChatModel 会话内切模型（POST /chat/model {providerId, model}）。
func (c *Client) ChatModel(ctx context.Context, providerID, model string) error {
	payload := map[string]any{"model": model}
	if providerID != "" {
		payload["providerId"] = providerID
	}
	raw, _ := json.Marshal(payload)
	return c.postRoot(ctx, "/chat/model", raw)
}

// ResetChat 清空当前会话上下文（POST /chat/reset）。旧 jsonl 保留可审计。
func (c *Client) ResetChat(ctx context.Context) error {
	return c.postRoot(ctx, "/chat/reset", json.RawMessage(`{}`))
}

// Rewind 回退到某条用户消息之前（POST /chat/rewind {userMessageId}）。
func (c *Client) Rewind(ctx context.Context, userMessageID string) error {
	raw, _ := json.Marshal(map[string]any{"userMessageId": userMessageID})
	return c.postRoot(ctx, "/chat/rewind", raw)
}

// Fork 从某条消息处分叉当前线（POST /sessions/fork {messageId}）。
func (c *Client) Fork(ctx context.Context, messageID string) error {
	raw, _ := json.Marshal(map[string]any{"messageId": messageID})
	return c.postRoot(ctx, "/sessions/fork", raw)
}

// ModelOption 是模型选择器的一行。
type ModelOption struct {
	ProviderID string
	Provider   string
	Model      string
	// Status 是 provider 的 key 状态（not-set / valid / invalid）——
	// 没配 key 的 provider 也列出来，但标出来，免得选了才发现不能用。
	Status string
	// Current 标记"当前生效的那个模型"。
	Current bool
}

// Models 取可选模型（admin model/list），拼成扁平列表。
func (c *Client) Models(ctx context.Context) ([]ModelOption, error) {
	res, err := c.Admin(ctx, "model/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	if !res.Success {
		return nil, fmt.Errorf("%s", res.Error)
	}
	// data 是 provider 数组，models 是**对象数组**（{model, modelName, …}）——
	// 不是字符串数组。早先按 []string 解会直接报"cannot unmarshal object"。
	var providers []struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Status string `json:"status"`
		HasKey bool   `json:"hasApiKey"`
		Models []struct {
			Model     string `json:"model"`
			ModelName string `json:"modelName"`
		} `json:"models"`
	}
	if err := json.Unmarshal(res.Data, &providers); err != nil {
		return nil, fmt.Errorf("model/list 数据结构不符：%w", err)
	}
	// admin 响应里 current 在信封层（不是 data 里），由 AdminResult.Current 单独带出。
	var cur struct {
		ProviderID string `json:"providerId"`
		ModelID    string `json:"modelId"`
	}
	_ = json.Unmarshal(res.Current, &cur)
	var out []ModelOption
	for _, p := range providers {
		status := p.Status
		if status == "" {
			if p.HasKey {
				status = "valid"
			} else {
				status = "not-set"
			}
		}
		for _, m := range p.Models {
			name := m.Model
			if name == "" {
				name = m.ModelName
			}
			out = append(out, ModelOption{
				ProviderID: p.ID,
				Provider:   p.Name,
				Model:      name,
				Status:     status,
				Current:    p.ID == cur.ProviderID && name == cur.ModelID,
			})
		}
	}
	return out, nil
}

// CancelQueueItem 撤销一条排队/纠偏消息（POST /chat/queue/cancel {queueId}）。
func (c *Client) CancelQueueItem(ctx context.Context, queueID string) error {
	raw, _ := json.Marshal(map[string]any{"queueId": queueID})
	return c.postRoot(ctx, "/chat/queue/cancel", raw)
}

// WorkspaceFile 是 @ 补全的一项（path 是相对 agentDir 的 POSIX 路径）。
type WorkspaceFile struct {
	Path string `json:"path"`
	Type string `json:"type"` // file / dir
}

// WorkspaceFiles 列出工作区文件（GET /api/workspace/files）。
//
// agentDir 显式传：TUI 从 chat:init 拿到本会话工作目录，不能依赖服务端的
// "当前目录"（多线并行时会串）。
func (c *Client) WorkspaceFiles(ctx context.Context, agentDir string, maxDepth int) ([]WorkspaceFile, error) {
	q := url.Values{}
	if agentDir != "" {
		q.Set("agentDir", agentDir)
	}
	if maxDepth > 0 {
		q.Set("depth", fmt.Sprintf("%d", maxDepth))
	}
	req, err := c.newRequest(ctx, http.MethodGet, "/api/workspace/files?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		Success bool            `json:"success"`
		Error   string          `json:"error"`
		Files   []WorkspaceFile `json:"files"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("workspace/files 解析失败：%w", err)
	}
	if !out.Success {
		return nil, fmt.Errorf("%s", out.Error)
	}
	return out.Files, nil
}

// AgentInfo 是 /api/agents 的一项。
type AgentInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Scope       string `json:"scope"`
}

// SubAgents 列出可用子代理（GET /api/agents）。
func (c *Client) SubAgents(ctx context.Context, agentDir string) ([]AgentInfo, error) {
	q := url.Values{}
	if agentDir != "" {
		q.Set("agentDir", agentDir)
	}
	req, err := c.newRequest(ctx, http.MethodGet, "/api/agents?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		Success bool        `json:"success"`
		Error   string      `json:"error"`
		Agents  []AgentInfo `json:"agents"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("agents 解析失败：%w", err)
	}
	if !out.Success {
		return nil, fmt.Errorf("%s", out.Error)
	}
	return out.Agents, nil
}

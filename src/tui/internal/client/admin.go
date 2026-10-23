package client

import (
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

// adminTimeout 是管理面请求的预算。比探活宽得多：environment/list 要扫配方
// 与域清单、task/list 要过 Rust Management API，本机也可能到秒级。
const adminTimeout = 15 * time.Second

// AdminResult 是 /api/admin/* 的统一响应信封（src/server/index.ts 的
// admin 分支：`{success, data?, error?, recoveryHint?}`）。
//
// data 保留 RawMessage：不同路由的 data 形状完全不同（数组、对象、嵌套），
// 先解成 any 只会让调用方再解一次。
type AdminResult struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   string          `json:"error"`
	// Current 是少数路由（model/list）在**信封层**多塞的一份"当前生效项"。
	// 它不在 data 里，所以只能单独留一份原文给调用方解。
	Current json.RawMessage `json:"current"`
}

// Admin 发一条 admin 路由请求。
//
// 业务失败（success=false）不返回 error——它是服务端的正常答复，调用方要
// 把 error 文本上屏；只有传输层失败才是 error。
func (c *Client) Admin(ctx context.Context, route string, payload any) (AdminResult, error) {
	var body io.Reader
	if payload == nil {
		payload = map[string]any{}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return AdminResult{}, err
	}
	body = bytes.NewReader(raw)

	reqCtx, cancel := context.WithTimeout(ctx, adminTimeout)
	defer cancel()
	req, err := c.newRequest(reqCtx, http.MethodPost, "/api/admin/"+strings.TrimPrefix(route, "/"), body)
	if err != nil {
		return AdminResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return AdminResult{}, err
	}
	defer resp.Body.Close()
	rawResp, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))

	var out AdminResult
	if err := json.Unmarshal(rawResp, &out); err != nil {
		return AdminResult{}, fmt.Errorf("admin %s: HTTP %d，响应不是 JSON：%s",
			route, resp.StatusCode, truncateForError(rawResp))
	}
	if !out.Success && out.Error == "" {
		out.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	return out, nil
}

// EnvironmentInfo 是 environment/list 的 data.environments[] 元素。
//
// 字段取自 src/shared/config-types.ts::EnvironmentEntry，只保留 TUI 要显示的；
// 响应里还有 recipeIds/capabilityMissing/occupancy 等，M2a 不消费。
type EnvironmentInfo struct {
	ID                string   `json:"id"`
	Kind              string   `json:"kind"`
	Name              string   `json:"name"`
	Host              string   `json:"host"`
	Container         string   `json:"container"`
	Address           string   `json:"address"`
	User              string   `json:"user"`
	CapabilityDomains []string `json:"capabilityDomains"`
}

// SessionStats 是会话统计（src/server/types/session.ts::SessionStats 子集）。
type SessionStats struct {
	MessageCount int `json:"messageCount"`
}

// SessionInfo 是 GET /sessions 的 sessions[] 元素（SessionMetadata 子集）。
type SessionInfo struct {
	ID            string        `json:"id"`
	Title         string        `json:"title"`
	LoopSessionID string        `json:"loopSessionId"`
	LastActiveAt  string        `json:"lastActiveAt"`
	Archived      bool          `json:"archived"`
	Stats         *SessionStats `json:"stats"`
}

// MessageCount 返回用户消息数（无 stats 时 0）。
func (s SessionInfo) MessageCount() int {
	if s.Stats == nil {
		return 0
	}
	return s.Stats.MessageCount
}

// TaskInfo 是 task/list 的 data[] 元素。
//
// 注意两点都与任务书写的不同：data 是**数组本身**（不是 data.tasks），
// 字段是 camelCase（src-tauri/src/task.rs::Task 带 rename_all="camelCase"）。
type TaskInfo struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Status       string   `json:"status"`
	Executor     string   `json:"executor"`
	Tags         []string `json:"tags"`
	CreatedAt    int64    `json:"createdAt"`
	UpdatedAt    int64    `json:"updatedAt"`
	LastExecuted int64    `json:"lastExecutedAt"`
	// DispatchOrigin: "direct" | "ai-aligned" | "system"。面板用它在行上打 sys 徽记。
	DispatchOrigin string `json:"dispatchOrigin"`
}

// ArchiveEntity 是 archive/list 的 data.archive.entities[] 元素
// （src/server/loop/archive.ts::ArchiveEntity）。
type ArchiveEntity struct {
	ID          string   `json:"id"`
	Kind        string   `json:"kind"` // hypothesis / finding / evidence / question
	Text        string   `json:"text"`
	Status      string   `json:"status"`
	Links       []string `json:"links"`
	Against     []string `json:"against"`
	NeedsReview bool     `json:"needsReview"`
}

// Environments 取环境清单（environment/list）。
func (c *Client) Environments(ctx context.Context) ([]EnvironmentInfo, error) {
	res, err := c.Admin(ctx, "environment/list", nil)
	if err != nil {
		return nil, err
	}
	if !res.Success {
		return nil, fmt.Errorf("%s", res.Error)
	}
	var body struct {
		Environments []EnvironmentInfo `json:"environments"`
	}
	if err := json.Unmarshal(res.Data, &body); err != nil {
		return nil, fmt.Errorf("environment/list 数据结构不符：%w", err)
	}
	return body.Environments, nil
}

// SelectEnvironment 切环境。
//
// 真实签名是 { workspace, selection:{kind:"env", id} }（admin-api.ts::
// handleEnvironmentSelect + define validateEnvSelection），**不是**任务书里的
// {id}——workspace 必须是本会话的 agentDir（TUI 从 chat:init 拿到）。
// 返回切换后绑定的会话线 id（可能为空）。
func (c *Client) SelectEnvironment(ctx context.Context, workspace, id string) (string, error) {
	res, err := c.Admin(ctx, "environment/select", map[string]any{
		"workspace": workspace,
		"selection": map[string]any{"kind": "env", "id": id},
	})
	if err != nil {
		return "", err
	}
	if !res.Success {
		return "", fmt.Errorf("%s", res.Error)
	}
	var body struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(res.Data, &body)
	return body.SessionID, nil
}

// Sessions 列会话线（GET /sessions，不是 admin 路由）。
func (c *Client) Sessions(ctx context.Context) ([]SessionInfo, error) {
	reqCtx, cancel := context.WithTimeout(ctx, adminTimeout)
	defer cancel()
	req, err := c.newRequest(reqCtx, http.MethodGet, "/sessions", nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	var body struct {
		Success  bool          `json:"success"`
		Sessions []SessionInfo `json:"sessions"`
		Error    string        `json:"error"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("/sessions: HTTP %d，响应不是 JSON：%s", resp.StatusCode, truncateForError(raw))
	}
	if !body.Success {
		if body.Error == "" {
			body.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("%s", body.Error)
	}
	return body.Sessions, nil
}

// SwitchSession 切到另一条会话线（POST /sessions/switch，body {sessionId}）。
func (c *Client) SwitchSession(ctx context.Context, id string) error {
	raw, err := json.Marshal(map[string]string{"sessionId": id})
	if err != nil {
		return err
	}
	reqCtx, cancel := context.WithTimeout(ctx, adminTimeout)
	defer cancel()
	req, err := c.newRequest(reqCtx, http.MethodPost, "/sessions/switch", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var out struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
	}
	_ = json.Unmarshal(body, &out)
	if resp.StatusCode != http.StatusOK || !out.Success {
		if out.Error == "" {
			out.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return fmt.Errorf("%s", out.Error)
	}
	return nil
}

// Tasks 取任务清单（task/list）。
func (c *Client) Tasks(ctx context.Context) ([]TaskInfo, error) {
	// includeSystem: TUI 的任务面板回答的是「现在有什么在跑」——系统任务
	// （蒸馏弧这类）恰恰在跑，隐藏它们会让面板永远是空表。CLI 侧仍按
	// Rust 语义默认隐藏（那是脚本口径，另议）。
	res, err := c.Admin(ctx, "task/list", map[string]any{"includeSystem": true})
	if err != nil {
		return nil, err
	}
	if !res.Success {
		return nil, fmt.Errorf("%s", res.Error)
	}
	// data 直接就是数组（admin-api.ts::handleTaskList 返回 { success, data: tasks }）。
	var tasks []TaskInfo
	if err := json.Unmarshal(res.Data, &tasks); err != nil {
		return nil, fmt.Errorf("task/list 数据结构不符：%w", err)
	}
	return tasks, nil
}

// Archive 取研究档案（archive/list {sessionId}）。
func (c *Client) Archive(ctx context.Context, sessionID string) ([]ArchiveEntity, error) {
	res, err := c.Admin(ctx, "archive/list", map[string]any{"sessionId": sessionID})
	if err != nil {
		return nil, err
	}
	if !res.Success {
		return nil, fmt.Errorf("%s", res.Error)
	}
	var body struct {
		Archive struct {
			Entities []ArchiveEntity `json:"entities"`
		} `json:"archive"`
	}
	if err := json.Unmarshal(res.Data, &body); err != nil {
		return nil, fmt.Errorf("archive/list 数据结构不符：%w", err)
	}
	return body.Archive.Entities, nil
}

// urlQueryEscape 单独抽出来：这行在热路径之外，但读起来比内联清楚。
func urlQueryEscape(s string) string { return url.QueryEscape(s) }

func truncateForError(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}

// WirePage 是 GET /api/loop-session/messages?format=wire 的一页。
//
// Total 是盘上的总条数（服务端 2000 条护栏之外还会截断），Truncated 表示
// 服务端自己截过——客户端再按自己的窗口（200 条）折一次。
type WirePage struct {
	Messages  []protocol.Snapshot
	Total     int
	Truncated bool
}

// WireMessages 拉一条会话线的 wire 消息（只读回看用）。
//
// format=wire 的形状与 /chat:stream 的冷历史重放逐字段对齐
// （src/server/loop/wire-replay.ts::LoopWireMessage），所以前端可以用同一个
// 归约器灌进独立的 Store。
func (c *Client) WireMessages(ctx context.Context, loopSessionID string) (WirePage, error) {
	if strings.TrimSpace(loopSessionID) == "" {
		return WirePage{}, fmt.Errorf("loopSessionId 为空")
	}
	path := "/api/loop-session/messages?format=wire&loopSessionId=" + urlQueryEscape(loopSessionID)
	reqCtx, cancel := context.WithTimeout(ctx, adminTimeout)
	defer cancel()
	req, err := c.newRequest(reqCtx, http.MethodGet, path, nil)
	if err != nil {
		return WirePage{}, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return WirePage{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))

	var body struct {
		Success       bool                `json:"success"`
		Error         string              `json:"error"`
		Messages      []protocol.Snapshot `json:"messages"`
		TotalMessages int                 `json:"totalMessages"`
		Truncated     bool                `json:"truncated"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return WirePage{}, fmt.Errorf("loop-session/messages: HTTP %d，响应不是 JSON：%s",
			resp.StatusCode, truncateForError(raw))
	}
	if !body.Success {
		if body.Error == "" {
			body.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return WirePage{}, fmt.Errorf("%s", body.Error)
	}
	return WirePage{Messages: body.Messages, Total: body.TotalMessages, Truncated: body.Truncated}, nil
}

// ── 任务写操作（2.1 P0）──────────────────────────────────────────────────

// TaskUpdateStatus 改任务状态（task/update-status）。status 取值见服务端
// TASK_STATUSES：todo/running/verifying/done/blocked/stopped。
func (c *Client) TaskUpdateStatus(ctx context.Context, id, status, message string) error {
	payload := map[string]any{"id": id, "status": status}
	if message != "" {
		payload["message"] = message
	}
	res, err := c.Admin(ctx, "task/update-status", payload)
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("%s", res.Error)
	}
	return nil
}

// TaskRerun 重新武装一个已结束的任务（task/rerun）。
func (c *Client) TaskRerun(ctx context.Context, id string) error {
	res, err := c.Admin(ctx, "task/rerun", map[string]any{"id": id})
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("%s", res.Error)
	}
	return nil
}

// AutoRunInfo 是 auto-run 记录的展示面（只取 TUI 要显示/判断的字段）。
type AutoRunInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	EnvKey      string `json:"envKey"`
	Goal        string `json:"goal"`
	Status      string `json:"status"`
	Phase       string `json:"phase"`
	Turns       int    `json:"turns"`
	PauseReason string `json:"pauseReason"`
	Budget      struct {
		Kind  string  `json:"kind"`
		Limit float64 `json:"limit"`
		Spent float64 `json:"spent"`
	} `json:"budget"`
}

// AutoRunShow 取单条 auto-run 记录（auto-run/show {id}）。
func (c *Client) AutoRunShow(ctx context.Context, id string) (AutoRunInfo, error) {
	res, err := c.Admin(ctx, "auto-run/show", map[string]any{"id": id})
	if err != nil {
		return AutoRunInfo{}, err
	}
	if !res.Success {
		return AutoRunInfo{}, fmt.Errorf("%s", res.Error)
	}
	var body struct {
		Record AutoRunInfo `json:"record"`
	}
	if err := json.Unmarshal(res.Data, &body); err != nil {
		return AutoRunInfo{}, fmt.Errorf("auto-run/show 数据结构不符：%w", err)
	}
	return body.Record, nil
}

// AutoRunList 取记录列表（auto-run/list {workspace?}）。
func (c *Client) AutoRunList(ctx context.Context, workspace string) ([]AutoRunInfo, error) {
	payload := map[string]any{}
	if workspace != "" {
		payload["workspace"] = workspace
	}
	res, err := c.Admin(ctx, "auto-run/list", payload)
	if err != nil {
		return nil, err
	}
	if !res.Success {
		return nil, fmt.Errorf("%s", res.Error)
	}
	var body struct {
		Records []AutoRunInfo `json:"records"`
	}
	if err := json.Unmarshal(res.Data, &body); err != nil {
		return nil, fmt.Errorf("auto-run/list 数据结构不符：%w", err)
	}
	return body.Records, nil
}

// AutoRunStop 终止一条运行中的 auto-run（auto-run/stop {id}）。
func (c *Client) AutoRunStop(ctx context.Context, id string) error {
	res, err := c.Admin(ctx, "auto-run/stop", map[string]any{"id": id})
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("%s", res.Error)
	}
	return nil
}

// ReportExportInfo 是 report/export 的回执（服务端 ExportReportResult.data）。
type ReportExportInfo struct {
	ReportDir     string   `json:"reportDir"`
	EvidenceCount int      `json:"evidenceCount"`
	FindingCount  int      `json:"findingCount"`
	ArchivePath   string   `json:"archivePath"`
	DownloadID    string   `json:"downloadId"`
	Degraded      []string `json:"degraded"`
}

// ReportExport 导出研究报告（admin report/export {workspace}）。2.2 起不做脱敏。
//
// 这个调用可能**阻塞很久**：服务端会先发一条 host-write 越界审批（等人批），
// 批准后才做证据回收 + LLM 叙述（叙述自身 180s 上限）。调用方要给足预算。
func (c *Client) ReportExport(ctx context.Context, workspace string) (ReportExportInfo, error) {
	res, err := c.Admin(ctx, "report/export", map[string]any{
		"workspace": workspace,
	})
	if err != nil {
		return ReportExportInfo{}, err
	}
	if !res.Success {
		return ReportExportInfo{}, fmt.Errorf("%s", res.Error)
	}
	var info ReportExportInfo
	if err := json.Unmarshal(res.Data, &info); err != nil {
		return ReportExportInfo{}, fmt.Errorf("report/export 数据结构不符：%w", err)
	}
	return info, nil
}

// ── 环境写操作（2.1 P2）─────────────────────────────────────────────────

// EnvDown 停止一个环境实例（environment/down {id}）。
func (c *Client) EnvDown(ctx context.Context, id string) error {
	res, err := c.Admin(ctx, "environment/down", map[string]any{"id": id})
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("%s", res.Error)
	}
	return nil
}

// EnvRm 删除环境登记与实例（environment/rm {id}）。不可逆。
func (c *Client) EnvRm(ctx context.Context, id string) error {
	res, err := c.Admin(ctx, "environment/rm", map[string]any{"id": id})
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("%s", res.Error)
	}
	return nil
}

// EnvRename 改环境别名（environment/rename {id, name}；空串 = 清除别名）。
func (c *Client) EnvRename(ctx context.Context, id, name string) error {
	res, err := c.Admin(ctx, "environment/rename", map[string]any{"id": id, "name": name})
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("%s", res.Error)
	}
	return nil
}

// EnvRecipe 是 environment/recipes 的一项。
type EnvRecipe struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// EnvRecipes 列出可用环境配方（environment/recipes）。
func (c *Client) EnvRecipes(ctx context.Context) ([]EnvRecipe, error) {
	res, err := c.Admin(ctx, "environment/recipes", map[string]any{})
	if err != nil {
		return nil, err
	}
	if !res.Success {
		return nil, fmt.Errorf("%s", res.Error)
	}
	var body struct {
		Recipes []EnvRecipe `json:"recipes"`
	}
	if err := json.Unmarshal(res.Data, &body); err != nil {
		return nil, fmt.Errorf("environment/recipes 数据结构不符：%w", err)
	}
	return body.Recipes, nil
}

// ── 档案写操作（2.1 P2）─────────────────────────────────────────────────

// ArchiveCorrect 纠正一条档案实体（archive/correct {id, reason}）。
func (c *Client) ArchiveCorrect(ctx context.Context, sessionID, id, reason string) error {
	res, err := c.Admin(ctx, "archive/correct", map[string]any{
		"sessionId": sessionID, "id": id, "reason": reason,
	})
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("%s", res.Error)
	}
	return nil
}

// ArchiveResolve 证实假设 / 解决未决问题（archive/resolve {id, note?}）。
func (c *Client) ArchiveResolve(ctx context.Context, sessionID, id, note string) error {
	payload := map[string]any{"sessionId": sessionID, "id": id}
	if note != "" {
		payload["note"] = note
	}
	res, err := c.Admin(ctx, "archive/resolve", payload)
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("%s", res.Error)
	}
	return nil
}

// ArchiveAbandon 搁置假设/问题（archive/abandon {id, reason}）。
func (c *Client) ArchiveAbandon(ctx context.Context, sessionID, id, reason string) error {
	res, err := c.Admin(ctx, "archive/abandon", map[string]any{
		"sessionId": sessionID, "id": id, "reason": reason,
	})
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("%s", res.Error)
	}
	return nil
}

// ── 检索（2.1 P2：搜索面板）─────────────────────────────────────────────

// MemoryHit 是 memory/search 的一条结果。
type MemoryHit struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Content string `json:"content"`
	Source  string `json:"source"`
}

// SearchMemory 检索长期记忆（memory/search {q, limit}）。
func (c *Client) SearchMemory(ctx context.Context, q string) ([]MemoryHit, error) {
	res, err := c.Admin(ctx, "memory/search", map[string]any{"q": q, "limit": 20})
	if err != nil {
		return nil, err
	}
	if !res.Success {
		return nil, fmt.Errorf("%s", res.Error)
	}
	var body struct {
		Results []MemoryHit `json:"results"`
	}
	if err := json.Unmarshal(res.Data, &body); err != nil {
		return nil, fmt.Errorf("memory/search 数据结构不符：%w", err)
	}
	return body.Results, nil
}

// ExpertHit 是 expert/search 的一条结果。
type ExpertHit struct {
	ID      int    `json:"id"`
	Title   string `json:"title"`
	Kind    string `json:"kind"`
	Domain  string `json:"domain"`
	Content string `json:"content"`
}

// SearchExpert 检索专家知识库（expert/search {query}）。
func (c *Client) SearchExpert(ctx context.Context, q string) ([]ExpertHit, error) {
	res, err := c.Admin(ctx, "expert/search", map[string]any{"query": q})
	if err != nil {
		return nil, err
	}
	if !res.Success {
		return nil, fmt.Errorf("%s", res.Error)
	}
	var body struct {
		Results []ExpertHit `json:"results"`
	}
	if err := json.Unmarshal(res.Data, &body); err != nil {
		return nil, fmt.Errorf("expert/search 数据结构不符：%w", err)
	}
	return body.Results, nil
}

// SearchIntel 检索情报索引（intel/search {query}）。服务端回的是渲染好的文本。
func (c *Client) SearchIntel(ctx context.Context, q string) (string, int, error) {
	res, err := c.Admin(ctx, "intel/search", map[string]any{"query": q})
	if err != nil {
		return "", 0, err
	}
	if !res.Success {
		return "", 0, fmt.Errorf("%s", res.Error)
	}
	var body struct {
		Text     string `json:"text"`
		HitCount int    `json:"hitCount"`
	}
	if err := json.Unmarshal(res.Data, &body); err != nil {
		return "", 0, fmt.Errorf("intel/search 数据结构不符：%w", err)
	}
	return body.Text, body.HitCount, nil
}

// AutoRunStart 启动自动循环（auto-run/start）。返回 run id。
func (c *Client) AutoRunStart(ctx context.Context, name, goal, envKey, budgetKind string, budgetLimit float64, criteria []string) (string, error) {
	payload := map[string]any{
		"name":     name,
		"goal":     goal,
		"envKey":   envKey,
		"budget":   map[string]any{"kind": budgetKind, "limit": budgetLimit},
		"criteria": criteria,
	}
	res, err := c.Admin(ctx, "auto-run/start", payload)
	if err != nil {
		return "", err
	}
	if !res.Success {
		return "", fmt.Errorf("%s", res.Error)
	}
	var body struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Data, &body)
	return body.ID, nil
}

// ── 会话写操作（2.1 P2）─────────────────────────────────────────────────

// SessionPatch 改会话元数据（PATCH /sessions/:id）。
// title/archived/pinned/mission 都可选；只发要改的字段。
func (c *Client) SessionPatch(ctx context.Context, id string, patch map[string]any) error {
	body, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	req, err := c.newRequest(ctx, http.MethodPatch, "/sessions/"+url.PathEscape(id), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var out struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
	}
	_ = json.Unmarshal(raw, &out)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if out.Error == "" {
			out.Error = fmt.Sprintf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
		}
		return fmt.Errorf("%s", out.Error)
	}
	if !out.Success && out.Error != "" {
		return fmt.Errorf("%s", out.Error)
	}
	return nil
}

// SessionDelete 删除会话（DELETE /sessions/:id，含 transcript）。
func (c *Client) SessionDelete(ctx context.Context, id string) error {
	req, err := c.newRequest(ctx, http.MethodDelete, "/sessions/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var out struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
	}
	_ = json.Unmarshal(raw, &out)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if out.Error == "" {
			out.Error = fmt.Sprintf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
		}
		return fmt.Errorf("%s", out.Error)
	}
	return nil
}

// TaskStatusTransition 是一条状态变更记录。
type TaskStatusTransition struct {
	To      string `json:"to"`
	At      int64  `json:"at"`
	Actor   string `json:"actor"`
	Source  string `json:"source"`
	Message string `json:"message"`
}

// TaskDocs 是任务文档路径（内容不随 API 下发，只给路径）。
type TaskDocs struct {
	Dir         string `json:"dir"`
	TaskMD      string `json:"taskMd"`
	VerifyMD    string `json:"verifyMd"`
	ProgressMD  string `json:"progressMd"`
	AlignmentMD string `json:"alignmentMd"`
}

// TaskDetail 是 task/get 的展示面。
type TaskDetail struct {
	ID             string                 `json:"id"`
	Name           string                 `json:"name"`
	Description    string                 `json:"description"`
	Executor       string                 `json:"executor"`
	Status         string                 `json:"status"`
	ExecutionMode  string                 `json:"executionMode"`
	WorkspacePath  string                 `json:"workspacePath"`
	Model          string                 `json:"model"`
	ProviderID     string                 `json:"providerId"`
	PermissionMode string                 `json:"permissionMode"`
	CronExpression string                 `json:"cronExpression"`
	Tags           []string               `json:"tags"`
	SessionIDs     []string               `json:"sessionIds"`
	CreatedAt      int64                  `json:"createdAt"`
	UpdatedAt      int64                  `json:"updatedAt"`
	LastExecutedAt int64                  `json:"lastExecutedAt"`
	StatusHistory  []TaskStatusTransition `json:"statusHistory"`
	Docs           TaskDocs               `json:"docs"`
}

// TaskGet 取任务详情（task/get {id}）。
func (c *Client) TaskGet(ctx context.Context, id string) (TaskDetail, error) {
	res, err := c.Admin(ctx, "task/get", map[string]any{"id": id})
	if err != nil {
		return TaskDetail{}, err
	}
	if !res.Success {
		return TaskDetail{}, fmt.Errorf("%s", res.Error)
	}
	var detail TaskDetail
	if err := json.Unmarshal(res.Data, &detail); err != nil {
		return TaskDetail{}, fmt.Errorf("task/get 数据结构不符：%w", err)
	}
	return detail, nil
}

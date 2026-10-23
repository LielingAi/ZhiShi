// Package protocol 只做一件事：把 sidecar 的 SSE 线格式翻译成前端可消费的
// 事件。不碰网络、不碰 UI——纯解码，因此可以单测。
//
// 形状全部以服务端为准，不要在这里"补"字段：
//   - 帧格式见 src/server/sse.ts 的 formatSse / heartbeatChunk；
//   - 事件名与负载见 packages/zhishi-loop-core/src/sse-adapter.ts（turn 事件）
//     与 src/server/loop/chat-engine.ts（会话事件）。
package protocol

import (
	"encoding/json"
	"strings"
)

// Envelope 是一帧原始 SSE：事件名 + data 原文。
//
// data 保留 RawMessage 而不是先解码成 any：formatSse 对字符串负载按行拆成
// 多条 `data:`，语义是"拼接后仍是原始文本"，先走 map 会丢掉这层区别。
type Envelope struct {
	Event string
	Data  json.RawMessage
}

// Kind 是事件名。sidecar 的事件名是契约的一部分，客户端按名路由。
type Kind string

const (
	KindInit            Kind = "chat:init"
	KindMessageReplay   Kind = "chat:message-replay"
	KindMessageChunk    Kind = "chat:message-chunk"
	KindMessageComplete Kind = "chat:message-complete"
	KindMessageError    Kind = "chat:message-error"
	KindMessageStopped  Kind = "chat:message-stopped"
	KindThinkingStart   Kind = "chat:thinking-start"
	KindThinkingChunk   Kind = "chat:thinking-chunk"
	KindThinkingDone    Kind = "chat:thinking-complete"
	KindToolUseStart    Kind = "chat:tool-use-start"
	KindToolResult      Kind = "chat:tool-result-complete"
	KindStatus          Kind = "chat:status"
	KindContextUsage    Kind = "chat:context-usage"
	KindSystemInit      Kind = "chat:system-init"
	KindBoundaryAsk     Kind = "chat:boundary-ask"
	KindBoundaryExpired Kind = "chat:boundary-expired"
	KindDecision        Kind = "chat:decision-request"
	KindDecisionDone    Kind = "chat:decision-resolved"
	KindQueueAdded      Kind = "queue:added"
	KindQueueCancelled  Kind = "queue:cancelled"
	KindSubagentStart   Kind = "chat:subagent-started"
	KindSubagentDone    Kind = "chat:subagent-finished"
	KindSessionTitle    Kind = "chat:session-title-changed"
	KindLog             Kind = "chat:log"
	// 1.9.6 steering（运行中纠偏队列）与后台进程生命周期：GUI 一直在用，
	// TUI 之前完全不认识——用户会以为"消息丢了 / 后台任务没跑"。
	KindSteeringAdded     Kind = "chat:steering-added"
	KindSteeringCancelled Kind = "chat:steering-cancelled"
	KindBgStarted         Kind = "chat:bg-started"
	KindBgFinished        Kind = "chat:bg-finished"
	KindMission           Kind = "chat:mission-changed"
	KindArchiveChanged    Kind = "archive:changed"
	// auto-run（自动循环攻击链）四事件：GUI 有观察卡，TUI 之前完全不认识。
	KindAutoRunStarted   Kind = "auto-run:started"
	KindAutoRunPhase     Kind = "auto-run:phase-changed"
	KindAutoRunTurn      Kind = "auto-run:turn-completed"
	KindAutoRunCompleted Kind = "auto-run:completed"
)

// Snapshot 是 wire 消息快照——/chat/stream 冷历史重放与 live 共用同一形状
// （src/server/loop/wire-replay.ts 的 LoopWireMessage）。
type Snapshot struct {
	ID        string `json:"id"`
	Role      string `json:"role"`
	Content   string `json:"content"`
	Timestamp string `json:"timestamp"`
	Name      string `json:"name,omitempty"`
	OK        *bool  `json:"ok,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Choice    string `json:"choice,omitempty"`
}

// Event 是归一化事件：Kind 决定哪些字段有意义，其余留零值。
//
// M0 只解 TUI 真的要渲染的字段；边界 ask / 决策面板留 Raw 给上层做桩，
// 免得"猜"一个还没定稿的形状。
type Event struct {
	Kind      Kind
	SessionID string

	// chat:message-chunk / chat:message-error 的裸文本负载（string，不是对象）
	Text string

	// chat:thinking-start / chat:thinking-chunk / chat:thinking-complete
	Index int
	Delta string

	// chat:tool-use-start
	ToolID    string
	ToolName  string
	ToolInput json.RawMessage

	// chat:tool-result-complete
	ToolUseID  string
	ToolOutput string
	IsError    bool

	// chat:message-complete
	Model      string
	DurationMS int64
	ToolCount  int
	// chat:message-complete 的 usage。用于状态行的 token 累计——snapshot 里
	// 的 contextTokens 只是"最近一次调用的占用"，不是累计消耗。
	InputTokens  int
	OutputTokens int

	// queue:added / queue:cancelled 的队列项 id。
	QueueID string
	// chat:subagent-started / chat:subagent-finished 的子任务 id。
	TaskID string

	// chat:status / chat:init
	SessionState string
	// chat:init 的 agentDir。管理面 environment/select 要它当 workspace，
	// 是 TUI 唯一能拿到本会话工作目录的来源。
	AgentDir string
	// chat:init 的 environment.id（当前锚定的环境/配方）。attach 的
	// "当前环境"就取它。
	EnvID string

	// chat:context-usage
	ContextUsed   int
	ContextWindow int

	// chat:message-replay
	Snapshot   *Snapshot
	ReplayKind string

	// chat:decision-request / chat:boundary-ask ——「让人选择」的两类请求。
	//
	// RequestID 在决策里是 decisionId、在越界里是 askId；两者都由服务端生成，
	// 应答时必须原样带回（应答接口按 id 查 pending）。
	RequestID string
	Question  string   // 决策的问题正文
	Options   []string // 决策选项（越界的 options 也落这里）
	// 越界请求的语义标签（shell / file-write / network …）与对象清单。
	BoundaryKind string
	Objects      []string
	// 越界请求里"哪个工具、想干什么"——人工判断的关键信息。
	ToolDescription string
	// 谁提的（P2 署名）。空 = 未署名。
	RequestedBy string

	// chat:session-title-changed / chat:mission-changed
	Title   string
	Mission string
	// chat:bg-started / chat:bg-finished
	Tag      string
	PID      int
	Status   string
	ExitCode int

	// auto-run:* —— 自动循环的 id / 名字 / 阶段 / 轮次 / 预算 / 终态。
	AutoRunID   string
	Name        string
	Phase       string
	PrevPhase   string
	Turn        int
	Goal        string
	EnvKey      string
	Outcome     string
	Reason      string
	BudgetKind  string
	BudgetLimit int64
	BudgetSpent int64
	CriteriaN   int

	// 未解帧的原始负载
	Raw json.RawMessage
}

// LineParser 按行累积一帧 SSE。
//
// 只认 formatSse 实际会写的四种行：`event:`、`data:`、空行（帧边界）、
// `: ...`（心跳注释）。`id:`/`retry:` 服务端不发，按 SSE 规范忽略即可。
// 显式不用 bufio.Scanner 在内部读：把"行"留给调用方，解析逻辑才能纯测。
type LineParser struct {
	event   string
	data    []string
	hasData bool
}

// Feed 喂一行（不含换行符）。返回 true 表示凑满一帧。
func (p *LineParser) Feed(line string) (Envelope, bool) {
	line = strings.TrimSuffix(line, "\r")
	switch {
	case line == "":
		return p.flush()
	case strings.HasPrefix(line, ":"):
		return Envelope{}, false // 心跳（`: ping`）：不产生帧
	case strings.HasPrefix(line, "event:"):
		p.event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
	case strings.HasPrefix(line, "data:"):
		p.data = append(p.data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		p.hasData = true
	}
	return Envelope{}, false
}

// Reset 丢掉半帧——连接重连时用，避免半截 data 拼到新连接的帧里。
func (p *LineParser) Reset() {
	p.event, p.data, p.hasData = "", nil, false
}

func (p *LineParser) flush() (Envelope, bool) {
	if p.event == "" && !p.hasData {
		return Envelope{}, false
	}
	env := Envelope{Event: p.event}
	if p.hasData {
		env.Data = json.RawMessage(strings.Join(p.data, "\n"))
	}
	p.Reset()
	return env, true
}

// Decode 把帧翻译成 Event。未知事件名照样返回一个只带 Raw 的 Event（上层
// 记数即可），永不返回错误——一条不认识的帧不值得掐断整条流。
func Decode(env Envelope) Event {
	ev := Event{Kind: Kind(env.Event), Raw: env.Data}
	switch ev.Kind {
	case KindInit:
		ev.SessionState = strField(env.Data, "sessionState")
		ev.SessionID = strField(env.Data, "sessionId")
		ev.AgentDir = strField(env.Data, "agentDir")
		// environment 是嵌套对象（resolveSessionEnvAnchor：{kind,id,name,type}），
		// 顶层取值取不到，单独走一层。
		ev.EnvID = nestedStrField(env.Data, "environment", "id")
	case KindStatus:
		ev.SessionState = strField(env.Data, "sessionState")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindSystemInit:
		ev.SessionID = strField(env.Data, "sessionId")
	case KindMessageChunk, KindMessageError:
		// 裸字符串负载（string），不是对象——见 sse-adapter 注释"形状被客户端钉死"。
		ev.Text = strValue(env.Data)
	case KindMessageStopped:
		// data 是 null / 空；没有负载。
	case KindThinkingStart, KindThinkingDone:
		ev.Index = intField(env.Data, "index")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindThinkingChunk:
		ev.Index = intField(env.Data, "index")
		ev.Delta = strField(env.Data, "delta")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindToolUseStart:
		ev.ToolID = strField(env.Data, "id")
		ev.ToolName = strField(env.Data, "name")
		ev.ToolInput = rawField(env.Data, "input")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindToolResult:
		ev.ToolUseID = strField(env.Data, "toolUseId")
		ev.ToolOutput = strField(env.Data, "content")
		ev.IsError = boolField(env.Data, "isError")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindMessageComplete:
		ev.Model = strField(env.Data, "model")
		ev.DurationMS = int64(intField(env.Data, "duration_ms"))
		ev.ToolCount = intField(env.Data, "tool_count")
		ev.InputTokens = intField(env.Data, "input_tokens")
		ev.OutputTokens = intField(env.Data, "output_tokens")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindQueueAdded, KindQueueCancelled:
		ev.QueueID = strField(env.Data, "queueId")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindSubagentStart, KindSubagentDone:
		ev.TaskID = strField(env.Data, "taskId")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindDecision:
		ev.RequestID = strField(env.Data, "decisionId")
		ev.Question = strField(env.Data, "question")
		ev.Options = strSliceField(env.Data, "options")
		ev.RequestedBy = strField(env.Data, "requestedBy")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindDecisionDone:
		ev.RequestID = strField(env.Data, "decisionId")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindBoundaryAsk:
		ev.RequestID = strField(env.Data, "askId")
		ev.BoundaryKind = strField(env.Data, "kind")
		ev.Objects = strSliceField(env.Data, "objects")
		ev.Options = strSliceField(env.Data, "options")
		ev.ToolName = strField(env.Data, "toolName")
		ev.ToolDescription = strField(env.Data, "toolDescription")
		ev.RequestedBy = strField(env.Data, "requestedBy")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindBoundaryExpired:
		ev.RequestID = strField(env.Data, "askId")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindSteeringAdded, KindSteeringCancelled:
		ev.QueueID = strField(env.Data, "queueId")
		ev.Text = strField(env.Data, "messageText")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindBgStarted:
		ev.Tag = strField(env.Data, "tag")
		ev.PID = intField(env.Data, "pid")
		ev.Text = strField(env.Data, "commandPreview")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindBgFinished:
		ev.Tag = strField(env.Data, "tag")
		ev.Status = strField(env.Data, "status")
		ev.ExitCode = intField(env.Data, "exitCode")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindAutoRunStarted:
		ev.AutoRunID = strField(env.Data, "id")
		ev.Name = strField(env.Data, "name")
		ev.EnvKey = strField(env.Data, "envKey")
		ev.Goal = strField(env.Data, "goal")
		ev.CriteriaN = intField(env.Data, "criteriaCount")
		ev.BudgetKind, ev.BudgetLimit, ev.BudgetSpent = budgetField(env.Data)
		ev.Status = "running"
	case KindAutoRunPhase:
		ev.AutoRunID = strField(env.Data, "id")
		ev.Phase = strField(env.Data, "phase")
		ev.PrevPhase = strField(env.Data, "previousPhase")
	case KindAutoRunTurn:
		ev.AutoRunID = strField(env.Data, "id")
		ev.Turn = intField(env.Data, "turn")
		ev.Phase = strField(env.Data, "phase")
		ev.Status = strField(env.Data, "status")
		ev.BudgetKind, ev.BudgetLimit, ev.BudgetSpent = budgetField(env.Data)
	case KindAutoRunCompleted:
		ev.AutoRunID = strField(env.Data, "id")
		ev.Outcome = strField(env.Data, "outcome")
		ev.Reason = strField(env.Data, "reason")
	case KindSessionTitle:
		ev.Title = strField(env.Data, "title")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindMission:
		ev.Mission = strField(env.Data, "mission")
		ev.Text = strField(env.Data, "label")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindContextUsage:
		// 负载是归一化快照 src/shared/types/context-usage.ts::ContextUsage
		// （contextTokens/contextWindow/usedPercent…），不是 computeContextUsage
		// 的入参名。
		ev.ContextUsed = intField(env.Data, "contextTokens")
		ev.ContextWindow = intField(env.Data, "contextWindow")
		ev.SessionID = strField(env.Data, "sessionId")
	case KindMessageReplay:
		var body struct {
			Message    *Snapshot `json:"message"`
			ReplayKind string    `json:"replayKind"`
			SessionID  string    `json:"sessionId"`
		}
		if json.Unmarshal(env.Data, &body) == nil {
			ev.Snapshot = body.Message
			ev.ReplayKind = body.ReplayKind
			ev.SessionID = body.SessionID
		}
	}
	return ev
}

// frame 是 object 负载的宽松视图。字段按需取，取不到就是零值——上游加字段
// 不应该让老客户端报错。
type frame map[string]json.RawMessage

func parseObject(data json.RawMessage) frame {
	if len(data) == 0 || data[0] != '{' {
		return nil
	}
	var f frame
	if json.Unmarshal(data, &f) != nil {
		return nil
	}
	return f
}

func strField(data json.RawMessage, key string) string {
	f := parseObject(data)
	if f == nil {
		return ""
	}
	return strValue(f[key])
}

// nestedStrField 取 obj[key][sub] 的字符串值（嵌套对象里的字段）。
func nestedStrField(data json.RawMessage, key, sub string) string {
	inner := rawField(data, key)
	if len(inner) == 0 {
		return ""
	}
	return strField(inner, sub)
}

func strValue(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	// 不是 JSON 字符串就按原文返回：宁可显示带引号的脏文本，也不吞内容。
	return strings.Trim(string(raw), "\"")
}

func intField(data json.RawMessage, key string) int {
	f := parseObject(data)
	if f == nil {
		return 0
	}
	var n float64
	if json.Unmarshal(f[key], &n) != nil {
		return 0
	}
	return int(n)
}

func boolField(data json.RawMessage, key string) bool {
	f := parseObject(data)
	if f == nil {
		return false
	}
	var b bool
	if json.Unmarshal(f[key], &b) != nil {
		return false
	}
	return b
}

// strSliceField 取字符串数组字段（决策的 options、越界的 objects）。
func strSliceField(data json.RawMessage, key string) []string {
	raw := rawField(data, key)
	if len(raw) == 0 {
		return nil
	}
	var out []string
	if json.Unmarshal(raw, &out) != nil {
		return nil
	}
	return out
}

func rawField(data json.RawMessage, key string) json.RawMessage {
	f := parseObject(data)
	if f == nil {
		return nil
	}
	return f[key]
}

// budgetField 解 auto-run 的 budget 对象：{kind, limit, spent?}。
func budgetField(data json.RawMessage) (kind string, limit, spent int64) {
	raw := rawField(data, "budget")
	if len(raw) == 0 {
		return "", 0, 0
	}
	var b struct {
		Kind  string  `json:"kind"`
		Limit float64 `json:"limit"`
		Spent float64 `json:"spent"`
	}
	if json.Unmarshal(raw, &b) != nil {
		return "", 0, 0
	}
	return b.Kind, int64(b.Limit), int64(b.Spent)
}

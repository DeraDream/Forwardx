package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sublink/models"
	nodeparser "sublink/node"
	"sync"
	"time"
)

type Manager struct {
	mu     sync.Mutex
	cancel context.CancelFunc
	bot    *Bot
}

type Bot struct {
	config      models.TelegramConfig
	client      *http.Client
	mu          sync.Mutex
	states      map[int64]string
	pendingSubs map[int64]*pendingSubscription
}

type pendingSubscription struct {
	Name    string
	NodeIDs map[int]bool
}

type updateResponse struct {
	OK          bool     `json:"ok"`
	Result      []Update `json:"result"`
	Description string   `json:"description"`
}

type apiResponse struct {
	OK          bool   `json:"ok"`
	Description string `json:"description"`
}

type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message"`
	CallbackQuery *CallbackQuery `json:"callback_query"`
}

type Message struct {
	MessageID      int64    `json:"message_id"`
	Chat           Chat     `json:"chat"`
	Text           string   `json:"text"`
	ReplyToMessage *Message `json:"reply_to_message,omitempty"`
}

type Chat struct {
	ID int64 `json:"id"`
}

type CallbackQuery struct {
	ID      string   `json:"id"`
	Data    string   `json:"data"`
	Message *Message `json:"message"`
}

type inlineKeyboard struct {
	InlineKeyboard [][]inlineButton `json:"inline_keyboard"`
}

type inlineButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data"`
}

type replyKeyboard struct {
	Keyboard              [][]replyButton `json:"keyboard"`
	ResizeKeyboard        bool            `json:"resize_keyboard"`
	OneTimeKeyboard       bool            `json:"one_time_keyboard"`
	IsPersistent          bool            `json:"is_persistent"`
	InputFieldPlaceholder string          `json:"input_field_placeholder,omitempty"`
}

type replyButton struct {
	Text string `json:"text"`
}

var DefaultManager = &Manager{}

func (m *Manager) Reload(config models.TelegramConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
		m.bot = nil
	}
	if !config.Enabled {
		return nil
	}
	if strings.TrimSpace(config.Token) == "" {
		return errors.New("Telegram Token 不能为空")
	}
	if len(parseAdminIDs(config.AdminChatIDs)) == 0 {
		return errors.New("至少配置一个管理员聊天 ID")
	}

	bot := NewBot(config)
	if err := bot.GetMe(); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.bot = bot
	go bot.Run(ctx)
	return nil
}

func (m *Manager) TestMessage(config models.TelegramConfig) error {
	if strings.TrimSpace(config.Token) == "" {
		return errors.New("Telegram Token 不能为空")
	}
	ids := parseAdminIDs(config.AdminChatIDs)
	if len(ids) == 0 {
		return errors.New("至少配置一个管理员聊天 ID")
	}
	bot := NewBot(config)
	if err := bot.GetMe(); err != nil {
		return err
	}
	for _, id := range ids {
		if err := bot.SendHTML(id, "✅ <b>SublinkX Telegram 机器人连接测试成功</b>", mainReplyKeyboard()); err != nil {
			return err
		}
	}
	return nil
}

func NewBot(config models.TelegramConfig) *Bot {
	if strings.TrimSpace(config.APIBaseURL) == "" {
		config.APIBaseURL = "https://api.telegram.org"
	}
	return &Bot{
		config:      config,
		client:      &http.Client{Timeout: 40 * time.Second},
		states:      make(map[int64]string),
		pendingSubs: make(map[int64]*pendingSubscription),
	}
}

func (b *Bot) Run(ctx context.Context) {
	var offset int64
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		updates, err := b.getUpdates(ctx, offset)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Println("Telegram 获取消息失败:", err)
			time.Sleep(3 * time.Second)
			continue
		}
		for _, update := range updates {
			offset = update.UpdateID + 1
			b.handleUpdate(update)
		}
	}
}

func (b *Bot) GetMe() error {
	var response apiResponse
	if err := b.call("getMe", nil, &response); err != nil {
		return err
	}
	if !response.OK {
		return errors.New(response.Description)
	}
	return nil
}

func (b *Bot) getUpdates(ctx context.Context, offset int64) ([]Update, error) {
	payload := map[string]any{
		"offset":          offset,
		"timeout":         30,
		"allowed_updates": []string{"message", "callback_query"},
	}
	var response updateResponse
	if err := b.callContext(ctx, "getUpdates", payload, &response); err != nil {
		return nil, err
	}
	if !response.OK {
		return nil, errors.New(response.Description)
	}
	return response.Result, nil
}

func (b *Bot) handleUpdate(update Update) {
	if update.CallbackQuery != nil && update.CallbackQuery.Message != nil {
		query := update.CallbackQuery
		chatID := query.Message.Chat.ID
		if !b.isAdmin(chatID) {
			_ = b.answerCallback(query.ID, "无权操作")
			return
		}
		_ = b.answerCallback(query.ID, "")
		b.handleCallback(chatID, query.Data)
		return
	}
	if update.Message == nil || strings.TrimSpace(update.Message.Text) == "" {
		return
	}
	chatID := update.Message.Chat.ID
	if !b.isAdmin(chatID) {
		_ = b.SendHTML(chatID, fmt.Sprintf("⛔ <b>当前 Chat ID 未授权</b>\n\n<code>%d</code>", chatID), nil)
		return
	}
	b.handleMessage(chatID, strings.TrimSpace(update.Message.Text))
}

func (b *Bot) handleMessage(chatID int64, text string) {
	command := normalizeCommand(text)
	if text == "/cancel" {
		b.setState(chatID, "")
		b.clearPendingSubscription(chatID)
		_ = b.SendHTML(chatID, "已取消当前操作。", mainReplyKeyboard())
		return
	}

	state := b.getState(chatID)
	if strings.HasPrefix(state, "set_sub_expire:") && !strings.HasPrefix(text, "/") {
		b.setSubscriptionExpire(chatID, strings.TrimPrefix(state, "set_sub_expire:"), text)
		return
	}
	if strings.HasPrefix(state, "set_sub_limit:") && !strings.HasPrefix(text, "/") {
		b.setSubscriptionLimit(chatID, strings.TrimPrefix(state, "set_sub_limit:"), text)
		return
	}
	if state == "add_sub_name" && !strings.HasPrefix(text, "/") && !isMenuCommand(command) {
		b.startSubscriptionNodePicker(chatID, text)
		return
	}
	if state == "add_node" && !strings.HasPrefix(text, "/") && !isMenuCommand(command) {
		b.addNode(chatID, text)
		return
	}
	if isMenuCommand(command) {
		b.setState(chatID, "")
		b.clearPendingSubscription(chatID)
	}

	switch command {
	case "/start", "/menu":
		_ = b.SendHTML(chatID, welcomeMessage(), mainReplyKeyboard())
	case "/id":
		_ = b.SendHTML(chatID, fmt.Sprintf("🪪 <b>当前 Chat ID</b>\n\n<code>%d</code>", chatID), mainReplyKeyboard())
	case "/nodes", "📋 节点列表":
		b.sendNodeList(chatID)
	case "/subs", "🧾 订阅列表":
		b.sendSubscriptionList(chatID)
	case "/addsub", "➕ 添加订阅":
		b.promptAddSubscription(chatID)
	case "/addnode", "➕ 添加节点":
		b.promptAddNode(chatID)
	case "🗑 删除节点":
		b.sendDeleteNodeList(chatID)
	default:
		_ = b.SendHTML(chatID, "我还不认识这个指令。请使用输入框上方的菜单操作。", mainReplyKeyboard())
	}
}

func (b *Bot) handleCallback(chatID int64, data string) {
	switch {
	case data == "nodes":
		b.sendNodeList(chatID)
	case data == "subs":
		b.sendSubscriptionList(chatID)
	case data == "add_sub":
		b.promptAddSubscription(chatID)
	case strings.HasPrefix(data, "toggle_sub_node:"):
		b.togglePendingSubscriptionNode(chatID, strings.TrimPrefix(data, "toggle_sub_node:"))
	case data == "finish_add_sub":
		b.finishAddSubscription(chatID)
	case data == "cancel_add_sub":
		b.clearPendingSubscription(chatID)
		_ = b.SendHTML(chatID, "已取消添加订阅。", mainReplyKeyboard())
	case strings.HasPrefix(data, "sub_logs:"):
		b.sendSubscriptionLogs(chatID, strings.TrimPrefix(data, "sub_logs:"))
	case strings.HasPrefix(data, "sub_reset_token:"):
		b.resetSubscriptionToken(chatID, strings.TrimPrefix(data, "sub_reset_token:"))
	case strings.HasPrefix(data, "sub_revoke:"):
		b.setSubscriptionRevoked(chatID, strings.TrimPrefix(data, "sub_revoke:"), true)
	case strings.HasPrefix(data, "sub_restore:"):
		b.setSubscriptionRevoked(chatID, strings.TrimPrefix(data, "sub_restore:"), false)
	case strings.HasPrefix(data, "sub_expire:"):
		id := strings.TrimPrefix(data, "sub_expire:")
		b.setState(chatID, "set_sub_expire:"+id)
		_ = b.SendHTML(chatID, "⏳ <b>设置订阅到期日</b>\n\n请发送日期，例如 <code>2026-12-31</code>。\n发送 <code>0</code> 清除到期日，发送 <code>/cancel</code> 取消。", mainReplyKeyboard())
	case strings.HasPrefix(data, "sub_limit:"):
		id := strings.TrimPrefix(data, "sub_limit:")
		b.setState(chatID, "set_sub_limit:"+id)
		_ = b.SendHTML(chatID, "🔢 <b>设置访问次数限制</b>\n\n请发送数字，例如 <code>100</code>。\n发送 <code>0</code> 表示不限，发送 <code>/cancel</code> 取消。", mainReplyKeyboard())
	case data == "add_node":
		b.promptAddNode(chatID)
	case data == "delete_nodes":
		b.sendDeleteNodeList(chatID)
	case strings.HasPrefix(data, "delete_node:"):
		id := strings.TrimPrefix(data, "delete_node:")
		keyboard := inlineKeyboard{InlineKeyboard: [][]inlineButton{
			{{Text: "确认删除", CallbackData: "confirm_delete:" + id}, {Text: "取消", CallbackData: "nodes"}},
		}}
		_ = b.SendHTML(chatID, "⚠️ <b>确认删除这个节点？</b>\n\n删除后无法恢复。", keyboard)
	case strings.HasPrefix(data, "confirm_delete:"):
		b.deleteNode(chatID, strings.TrimPrefix(data, "confirm_delete:"))
	case data == "menu":
		_ = b.SendHTML(chatID, welcomeMessage(), mainReplyKeyboard())
	}
}

func (b *Bot) sendNodeList(chatID int64) {
	nodes, err := models.GetNodeList()
	if err != nil {
		_ = b.SendHTML(chatID, "读取节点失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}

	var text strings.Builder
	fmt.Fprintf(&text, "📋 <b>节点列表</b>\n")
	fmt.Fprintf(&text, "共 <b>%d</b> 个节点\n\n", len(nodes))
	if len(nodes) == 0 {
		text.WriteString("当前还没有节点。可以点击输入框上方的「➕ 添加节点」开始添加。")
	}
	for _, item := range nodes {
		groups := make([]string, 0, len(item.GroupNodes))
		for _, group := range item.GroupNodes {
			groups = append(groups, group.Name)
		}
		protocol := "unknown"
		if parsed, err := url.Parse(item.Link); err == nil && parsed.Scheme != "" {
			protocol = parsed.Scheme
		}

		fmt.Fprintf(&text, "▣ <b>#%d %s</b>\n", item.ID, escapeHTML(item.Name))
		fmt.Fprintf(&text, "协议：<code>%s</code>\n", escapeHTML(strings.ToUpper(protocol)))
		if len(groups) > 0 {
			fmt.Fprintf(&text, "分组：%s\n", escapeHTML(strings.Join(groups, " / ")))
		} else {
			text.WriteString("分组：未分组\n")
		}
		if item.Link != "" {
			fmt.Fprintf(&text, "%s 链接：\n%s\n", escapeHTML(strings.ToUpper(protocol)), htmlCodeBlock(item.Link))
		}
		text.WriteString("\n")
		if text.Len() > 3500 {
			text.WriteString("节点较多，当前消息仅展示前半部分。")
			break
		}
	}

	keyboard := inlineKeyboard{InlineKeyboard: [][]inlineButton{
		{{Text: "➕ 添加节点", CallbackData: "add_node"}, {Text: "🗑 删除节点", CallbackData: "delete_nodes"}},
		{{Text: "🔄 刷新列表", CallbackData: "nodes"}, {Text: "🏠 主菜单", CallbackData: "menu"}},
	}}
	_ = b.SendHTML(chatID, text.String(), keyboard)
}

func (b *Bot) sendDeleteNodeList(chatID int64) {
	nodes, err := models.GetNodeList()
	if err != nil {
		_ = b.SendHTML(chatID, "读取节点失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}
	rows := make([][]inlineButton, 0, len(nodes)+1)
	for index, item := range nodes {
		if index >= 40 {
			break
		}
		rows = append(rows, []inlineButton{{
			Text:         fmt.Sprintf("#%d %s", item.ID, item.Name),
			CallbackData: fmt.Sprintf("delete_node:%d", item.ID),
		}})
	}
	rows = append(rows, []inlineButton{{Text: "返回节点列表", CallbackData: "nodes"}})
	_ = b.SendHTML(chatID, "🗑 <b>选择要删除的节点</b>\n\n最多显示前 40 个节点。", inlineKeyboard{InlineKeyboard: rows})
}

func (b *Bot) sendSubscriptionList(chatID int64) {
	var sub models.Subcription
	subs, err := sub.List()
	if err != nil {
		_ = b.SendHTML(chatID, "读取订阅失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}

	var text strings.Builder
	fmt.Fprintf(&text, "🧾 <b>订阅列表</b>\n共 <b>%d</b> 个订阅\n\n", len(subs))
	if len(subs) == 0 {
		text.WriteString("当前还没有订阅。")
	}
	for index, item := range subs {
		token := item.Token
		if token == "" {
			token = models.LegacySubscriptionToken(item.Name)
		}
		status := "有效"
		if ok, reason := item.IsAvailable(time.Now()); !ok {
			status = reason
		}
		fmt.Fprintf(&text, "▣ <b>%d. %s</b>\n节点数：<code>%d</code>\n状态：<code>%s</code>\n访问：<code>%d/%s</code>\n", index+1, escapeHTML(item.Name), len(item.Nodes), escapeHTML(status), item.AccessCount, accessLimitText(item.AccessLimit))
		fmt.Fprintf(&text, "V2Ray：\n%s\n", htmlCodeBlock(b.subscriptionURLWithToken(token, "v2ray")))
		fmt.Fprintf(&text, "Clash：\n%s\n", htmlCodeBlock(b.subscriptionURLWithToken(token, "clash")))
		fmt.Fprintf(&text, "Surge：\n%s\n\n", htmlCodeBlock(b.subscriptionURLWithToken(token, "surge")))
		if text.Len() > 3500 {
			text.WriteString("订阅较多，当前消息仅展示前半部分。")
			break
		}
	}
	rows := [][]inlineButton{
		{{Text: "➕ 新建订阅", CallbackData: "add_sub"}},
	}
	for index, item := range subs {
		if index >= 10 {
			break
		}
		id := strconv.Itoa(item.ID)
		stateText := "失效"
		stateAction := "sub_revoke:" + id
		if item.Revoked {
			stateText = "恢复"
			stateAction = "sub_restore:" + id
		}
		rows = append(rows,
			[]inlineButton{{Text: "📄 " + item.Name + " 日志", CallbackData: "sub_logs:" + id}, {Text: "🔑 重置Token", CallbackData: "sub_reset_token:" + id}},
			[]inlineButton{{Text: "⏳ 到期日", CallbackData: "sub_expire:" + id}, {Text: "🔢 次数", CallbackData: "sub_limit:" + id}, {Text: stateText, CallbackData: stateAction}},
		)
	}
	rows = append(rows, []inlineButton{{Text: "🔄 刷新订阅", CallbackData: "subs"}, {Text: "🏠 主菜单", CallbackData: "menu"}})
	keyboard := inlineKeyboard{InlineKeyboard: rows}
	_ = b.SendHTML(chatID, text.String(), keyboard)
}

func (b *Bot) sendSubscriptionLogs(chatID int64, idText string) {
	var sub models.Subcription
	if err := models.DB.Preload("SubLogs").First(&sub, idText).Error; err != nil {
		_ = b.SendHTML(chatID, "读取订阅访问日志失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}
	var text strings.Builder
	fmt.Fprintf(&text, "📄 <b>%s 访问日志</b>\n\n", escapeHTML(sub.Name))
	if len(sub.SubLogs) == 0 {
		text.WriteString("暂无访问记录。")
	}
	for index, item := range sub.SubLogs {
		if index >= 20 {
			text.WriteString("\n仅显示最近 20 条。")
			break
		}
		fmt.Fprintf(&text, "▣ <code>%s</code>\n次数：<code>%d</code>\n来源：%s\n最近：<code>%s</code>\n\n", escapeHTML(item.IP), item.Count, escapeHTML(item.Addr), escapeHTML(item.Date))
	}
	_ = b.SendHTML(chatID, text.String(), inlineKeyboard{InlineKeyboard: [][]inlineButton{{{Text: "返回订阅列表", CallbackData: "subs"}}}})
}

func (b *Bot) resetSubscriptionToken(chatID int64, idText string) {
	token := models.GenerateSubscriptionToken()
	if token == "" {
		_ = b.SendHTML(chatID, "生成 token 失败。", mainReplyKeyboard())
		return
	}
	if err := models.DB.Model(&models.Subcription{}).Where("id = ?", idText).
		Updates(map[string]any{"token": token, "legacy_token_disabled": true, "revoked": false, "access_count": 0}).Error; err != nil {
		_ = b.SendHTML(chatID, "重置 token 失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}
	_ = b.SendHTML(chatID, "✅ <b>订阅 token 已重置</b>\n\nClash：\n"+htmlCodeBlock(b.subscriptionURLWithToken(token, "clash")), inlineKeyboard{InlineKeyboard: [][]inlineButton{{{Text: "返回订阅列表", CallbackData: "subs"}}}})
}

func (b *Bot) setSubscriptionRevoked(chatID int64, idText string, revoked bool) {
	if err := models.DB.Model(&models.Subcription{}).Where("id = ?", idText).Update("revoked", revoked).Error; err != nil {
		_ = b.SendHTML(chatID, "更新订阅状态失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}
	if revoked {
		_ = b.SendHTML(chatID, "✅ 订阅已手动失效。", inlineKeyboard{InlineKeyboard: [][]inlineButton{{{Text: "返回订阅列表", CallbackData: "subs"}}}})
		return
	}
	_ = b.SendHTML(chatID, "✅ 订阅已恢复。", inlineKeyboard{InlineKeyboard: [][]inlineButton{{{Text: "返回订阅列表", CallbackData: "subs"}}}})
}

func (b *Bot) setSubscriptionExpire(chatID int64, idText string, value string) {
	value = strings.TrimSpace(value)
	updates := map[string]any{}
	if value == "0" {
		updates["expire_at"] = nil
	} else {
		parsed, err := time.ParseInLocation("2006-01-02", value, time.Local)
		if err != nil {
			_ = b.SendHTML(chatID, "日期格式不正确，请发送例如 <code>2026-12-31</code>，或发送 <code>0</code> 清除。", mainReplyKeyboard())
			return
		}
		updates["expire_at"] = parsed
	}
	if err := models.DB.Model(&models.Subcription{}).Where("id = ?", idText).Updates(updates).Error; err != nil {
		_ = b.SendHTML(chatID, "设置到期日失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}
	b.setState(chatID, "")
	_ = b.SendHTML(chatID, "✅ 到期日已更新。", inlineKeyboard{InlineKeyboard: [][]inlineButton{{{Text: "返回订阅列表", CallbackData: "subs"}}}})
}

func (b *Bot) setSubscriptionLimit(chatID int64, idText string, value string) {
	limit, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || limit < 0 {
		_ = b.SendHTML(chatID, "次数格式不正确，请发送非负整数，例如 <code>100</code>。", mainReplyKeyboard())
		return
	}
	if err := models.DB.Model(&models.Subcription{}).Where("id = ?", idText).Update("access_limit", limit).Error; err != nil {
		_ = b.SendHTML(chatID, "设置访问次数失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}
	b.setState(chatID, "")
	_ = b.SendHTML(chatID, "✅ 访问次数限制已更新。", inlineKeyboard{InlineKeyboard: [][]inlineButton{{{Text: "返回订阅列表", CallbackData: "subs"}}}})
}

func (b *Bot) promptAddSubscription(chatID int64) {
	b.clearPendingSubscription(chatID)
	b.setState(chatID, "add_sub_name")
	_ = b.SendHTML(chatID, "➕ <b>新建订阅</b>\n\n请发送订阅名称，例如 <code>myclash</code>。\n发送 <code>/cancel</code> 可取消当前操作。", mainReplyKeyboard())
}

func (b *Bot) startSubscriptionNodePicker(chatID int64, name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		_ = b.SendHTML(chatID, "订阅名称不能为空，请重新发送。", mainReplyKeyboard())
		return
	}
	b.mu.Lock()
	b.pendingSubs[chatID] = &pendingSubscription{Name: name, NodeIDs: map[int]bool{}}
	b.states[chatID] = "add_sub_nodes"
	b.mu.Unlock()
	b.sendPendingSubscriptionNodePicker(chatID)
}

func (b *Bot) togglePendingSubscriptionNode(chatID int64, idText string) {
	id, err := strconv.Atoi(idText)
	if err != nil || id <= 0 {
		_ = b.SendHTML(chatID, "节点 ID 格式不正确。", mainReplyKeyboard())
		return
	}
	b.mu.Lock()
	pending := b.pendingSubs[chatID]
	if pending != nil {
		if pending.NodeIDs[id] {
			delete(pending.NodeIDs, id)
		} else {
			pending.NodeIDs[id] = true
		}
	}
	b.mu.Unlock()
	if pending == nil {
		_ = b.SendHTML(chatID, "当前没有正在创建的订阅。", mainReplyKeyboard())
		return
	}
	b.sendPendingSubscriptionNodePicker(chatID)
}

func (b *Bot) sendPendingSubscriptionNodePicker(chatID int64) {
	b.mu.Lock()
	pending := b.pendingSubs[chatID]
	b.mu.Unlock()
	if pending == nil {
		_ = b.SendHTML(chatID, "当前没有正在创建的订阅。", mainReplyKeyboard())
		return
	}
	nodes, err := models.GetNodeList()
	if err != nil {
		_ = b.SendHTML(chatID, "读取节点失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}
	rows := make([][]inlineButton, 0, len(nodes)+2)
	for index, item := range nodes {
		if index >= 40 {
			break
		}
		prefix := "☐"
		if pending.NodeIDs[item.ID] {
			prefix = "☑"
		}
		if item.Disabled {
			prefix += " 禁用"
		}
		rows = append(rows, []inlineButton{{
			Text:         fmt.Sprintf("%s #%d %s", prefix, item.ID, item.Name),
			CallbackData: fmt.Sprintf("toggle_sub_node:%d", item.ID),
		}})
	}
	rows = append(rows,
		[]inlineButton{{Text: "✅ 完成创建", CallbackData: "finish_add_sub"}, {Text: "取消", CallbackData: "cancel_add_sub"}},
	)
	text := fmt.Sprintf("➕ <b>新建订阅</b>\n名称：<code>%s</code>\n已选择：<code>%d</code> 个节点\n\n点击节点可切换选择。", escapeHTML(pending.Name), len(pending.NodeIDs))
	_ = b.SendHTML(chatID, text, inlineKeyboard{InlineKeyboard: rows})
}

func (b *Bot) finishAddSubscription(chatID int64) {
	b.mu.Lock()
	pending := b.pendingSubs[chatID]
	b.mu.Unlock()
	if pending == nil {
		_ = b.SendHTML(chatID, "当前没有正在创建的订阅。", mainReplyKeyboard())
		return
	}
	if len(pending.NodeIDs) == 0 {
		_ = b.SendHTML(chatID, "至少选择一个节点。", mainReplyKeyboard())
		return
	}
	nodes := make([]models.Node, 0, len(pending.NodeIDs))
	nodeNames := make([]string, 0, len(pending.NodeIDs))
	for id := range pending.NodeIDs {
		var item models.Node
		if err := models.DB.First(&item, id).Error; err != nil {
			_ = b.SendHTML(chatID, "读取节点失败："+escapeHTML(err.Error()), mainReplyKeyboard())
			return
		}
		nodes = append(nodes, item)
		nodeNames = append(nodeNames, item.Name)
	}
	sub := models.Subcription{
		Name:      pending.Name,
		Config:    `{"clash":"./template/clash.yaml","surge":"./template/surge.conf","udp":false,"cert":false}`,
		NodeOrder: strings.Join(nodeNames, ","),
		Nodes:     nodes,
	}
	if err := sub.Add(); err != nil {
		_ = b.SendHTML(chatID, "创建订阅失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}
	b.clearPendingSubscription(chatID)
	token := sub.Token
	if token == "" {
		token = models.LegacySubscriptionToken(sub.Name)
	}
	text := "✅ <b>订阅已创建</b>\n\n" +
		"名称：<code>" + escapeHTML(sub.Name) + "</code>\n" +
		"Clash：\n" + htmlCodeBlock(b.subscriptionURLWithToken(token, "clash"))
	_ = b.SendHTML(chatID, text, inlineKeyboard{InlineKeyboard: [][]inlineButton{{{Text: "返回订阅列表", CallbackData: "subs"}}}})
}

func (b *Bot) clearPendingSubscription(chatID int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.pendingSubs, chatID)
	delete(b.states, chatID)
}

func (b *Bot) promptAddNode(chatID int64) {
	b.setState(chatID, "add_node")
	_ = b.SendHTML(chatID, "➕ <b>添加节点</b>\n\n请发送节点链接。\n如需分组，请在第二行填写分组名，多个分组用逗号分隔。\n\n发送 <code>/cancel</code> 可取消当前操作。", mainReplyKeyboard())
}

func (b *Bot) addNode(chatID int64, input string) {
	lines := strings.Split(input, "\n")
	link := strings.TrimSpace(lines[0])
	if !strings.Contains(link, "://") {
		_ = b.SendHTML(chatID, "节点链接格式不正确，请重新发送，或使用 <code>/cancel</code> 取消。", mainReplyKeyboard())
		return
	}
	groupText := ""
	if len(lines) > 1 {
		groupText = strings.TrimSpace(lines[1])
	}
	item := models.Node{Link: link}
	name, err := decodeNodeName(link)
	if err != nil {
		_ = b.SendHTML(chatID, "解析节点失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}
	item.Name = name
	if err := item.Add(); err != nil {
		_ = b.SendHTML(chatID, "添加节点失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}
	if groupText != "" {
		for _, groupName := range strings.Split(groupText, ",") {
			groupName = strings.TrimSpace(groupName)
			if groupName == "" {
				continue
			}
			group := &models.GroupNode{Name: groupName}
			if err := group.Add(); err != nil {
				_ = b.SendHTML(chatID, "节点已添加，但创建分组失败："+escapeHTML(err.Error()), mainReplyKeyboard())
				return
			}
			if err := group.Ass(&item); err != nil {
				_ = b.SendHTML(chatID, "节点已添加，但关联分组失败："+escapeHTML(err.Error()), mainReplyKeyboard())
				return
			}
		}
	}
	b.setState(chatID, "")
	_ = b.SendHTML(chatID, "✅ <b>节点添加成功</b>\n\n"+escapeHTML(item.Name), mainReplyKeyboard())
}

func (b *Bot) deleteNode(chatID int64, idText string) {
	id, err := strconv.Atoi(idText)
	if err != nil {
		_ = b.SendHTML(chatID, "节点 ID 格式不正确。", mainReplyKeyboard())
		return
	}
	item := models.Node{ID: id}
	if err := models.DB.First(&item, id).Error; err != nil {
		_ = b.SendHTML(chatID, "节点不存在或已删除。", mainReplyKeyboard())
		return
	}
	name := item.Name
	if err := item.Del(); err != nil {
		_ = b.SendHTML(chatID, "删除节点失败："+escapeHTML(err.Error()), mainReplyKeyboard())
		return
	}
	_ = b.SendHTML(chatID, "✅ 节点已删除："+escapeHTML(name), mainReplyKeyboard())
}

func decodeNodeName(link string) (string, error) {
	parsed, err := url.Parse(link)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "ss":
		item, err := nodeparser.DecodeSSURL(link)
		return item.Name, err
	case "ssr":
		item, err := nodeparser.DecodeSSRURL(link)
		return item.Qurey.Remarks, err
	case "trojan":
		item, err := nodeparser.DecodeTrojanURL(link)
		return item.Name, err
	case "vmess":
		item, err := nodeparser.DecodeVMESSURL(link)
		return item.Ps, err
	case "vless":
		item, err := nodeparser.DecodeVLESSURL(link)
		return item.Name, err
	case "hy", "hysteria":
		item, err := nodeparser.DecodeHYURL(link)
		return item.Name, err
	case "hy2", "hysteria2":
		item, err := nodeparser.DecodeHY2URL(link)
		return item.Name, err
	case "tuic":
		item, err := nodeparser.DecodeTuicURL(link)
		return item.Name, err
	default:
		return "", fmt.Errorf("暂不支持 %s 协议", parsed.Scheme)
	}
}

func (b *Bot) SendMessage(chatID int64, text string, keyboard any) error {
	payload := map[string]any{"chat_id": chatID, "text": text}
	if keyboard != nil {
		payload["reply_markup"] = keyboard
	}
	var response apiResponse
	if err := b.call("sendMessage", payload, &response); err != nil {
		return err
	}
	if !response.OK {
		return errors.New(response.Description)
	}
	return nil
}

func (b *Bot) SendHTML(chatID int64, text string, keyboard any) error {
	payload := map[string]any{
		"chat_id":                  chatID,
		"text":                     text,
		"parse_mode":               "HTML",
		"disable_web_page_preview": true,
	}
	if keyboard != nil {
		payload["reply_markup"] = keyboard
	}
	var response apiResponse
	if err := b.call("sendMessage", payload, &response); err != nil {
		return err
	}
	if !response.OK {
		return errors.New(response.Description)
	}
	return nil
}

func (b *Bot) answerCallback(callbackID string, text string) error {
	payload := map[string]any{"callback_query_id": callbackID}
	if text != "" {
		payload["text"] = text
	}
	return b.call("answerCallbackQuery", payload, &apiResponse{})
}

func (b *Bot) call(method string, payload any, target any) error {
	return b.callContext(context.Background(), method, payload, target)
}

func (b *Bot) callContext(ctx context.Context, method string, payload any, target any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	endpoint := strings.TrimRight(b.config.APIBaseURL, "/") + "/bot" + b.config.Token + "/" + method
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := b.client.Do(request)
	if err != nil {
		return errors.New("无法连接 Telegram API")
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("Telegram API 返回 %d: %s", response.StatusCode, string(responseBody))
	}
	if err := json.Unmarshal(responseBody, target); err != nil {
		return err
	}
	return nil
}

func (b *Bot) isAdmin(chatID int64) bool {
	for _, id := range parseAdminIDs(b.config.AdminChatIDs) {
		if id == chatID {
			return true
		}
	}
	return false
}

func parseAdminIDs(value string) []int64 {
	matches := regexp.MustCompile(`-?\d+`).FindAllString(value, -1)
	ids := make([]int64, 0, len(matches))
	for _, match := range matches {
		id, err := strconv.ParseInt(match, 10, 64)
		if err == nil {
			ids = append(ids, id)
		}
	}
	return ids
}

func (b *Bot) getState(chatID int64) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.states[chatID]
}

func (b *Bot) setState(chatID int64, state string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if state == "" {
		delete(b.states, chatID)
		return
	}
	b.states[chatID] = state
}

func mainReplyKeyboard() replyKeyboard {
	return replyKeyboard{
		Keyboard: [][]replyButton{
			{{Text: "📋 节点列表"}, {Text: "🧾 订阅列表"}},
			{{Text: "➕ 添加节点"}, {Text: "➕ 添加订阅"}},
			{{Text: "🗑 删除节点"}},
		},
		ResizeKeyboard:        true,
		IsPersistent:          true,
		OneTimeKeyboard:       false,
		InputFieldPlaceholder: "选择下方按钮或发送节点链接",
	}
}

func normalizeCommand(text string) string {
	command := strings.TrimSpace(text)
	command = strings.TrimPrefix(command, "\ufeff")
	if strings.HasPrefix(command, "/") {
		command = strings.Split(command, " ")[0]
		if index := strings.Index(command, "@"); index > 0 {
			command = command[:index]
		}
		return command
	}
	command = strings.Join(strings.Fields(command), " ")
	command = strings.Trim(command, " \t\r\n。.!！")
	command = strings.TrimPrefix(command, "📋")
	command = strings.TrimPrefix(command, "🧾")
	command = strings.TrimPrefix(command, "➕")
	command = strings.TrimPrefix(command, "🗑")
	command = strings.TrimSpace(command)
	switch command {
	case "节点列表":
		return "📋 节点列表"
	case "订阅列表":
		return "🧾 订阅列表"
	case "添加节点":
		return "➕ 添加节点"
	case "添加订阅":
		return "➕ 添加订阅"
	case "删除节点":
		return "🗑 删除节点"
	default:
		return command
	}
}

func isMenuCommand(command string) bool {
	switch command {
	case "📋 节点列表", "🧾 订阅列表", "➕ 添加节点", "➕ 添加订阅", "🗑 删除节点", "/nodes", "/subs", "/addnode", "/addsub", "/menu", "/start":
		return true
	default:
		return false
	}
}

func htmlCodeBlock(value string) string {
	return "<pre><code>" + escapeHTML(value) + "</code></pre>"
}

func subscriptionPath(name string, client string) string {
	return subscriptionPathWithToken(models.LegacySubscriptionToken(name), client)
}

func subscriptionPathWithToken(token string, client string) string {
	path := "/c/?token=" + url.QueryEscape(token)
	if strings.TrimSpace(client) != "" {
		path += "&client=" + url.QueryEscape(strings.TrimSpace(client))
	}
	return path
}

func (b *Bot) subscriptionURLWithToken(token string, client string) string {
	return b.publicBaseURL() + subscriptionPathWithToken(token, client)
}

func (b *Bot) publicBaseURL() string {
	base := strings.TrimRight(strings.TrimSpace(b.config.PublicBaseURL), "/")
	if base == "" {
		base = "https://sublink.yforward7.com"
	}
	return base
}

func accessLimitText(limit int) string {
	if limit <= 0 {
		return "不限"
	}
	return strconv.Itoa(limit)
}

func welcomeMessage() string {
	return "✨ <b>SublinkX 管理机器人</b>\n\n输入框下方的常用按钮会保持显示。\n\n<pre><code>节点列表\n订阅列表\n添加节点\n删除节点</code></pre>"
}

func escapeHTML(value string) string {
	return html.EscapeString(value)
}

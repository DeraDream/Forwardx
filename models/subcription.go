package models

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strconv"
	"strings" // 用于处理逗号分隔的字符串
	"time"

	"gorm.io/gorm"
)

// Subcription 结构体
type Subcription struct {
	gorm.Model
	ID                  int
	Name                string
	Config              string `gorm:"type:text"` // Config 存储为 JSON 字符串
	NodeOrder           string `gorm:"type:text"`
	Token               string `gorm:"index"`
	LegacyTokenDisabled bool
	Revoked             bool
	ExpireAt            *time.Time
	AccessLimit         int
	AccessCount         int
	Nodes               []Node    `gorm:"many2many:subcription_nodes;"`
	SubLogs             []SubLogs `gorm:"foreignKey:SubcriptionID;"`
}

// Config 结构体，用于解析 Subcription.Config 字段的 JSON 内容
// 命名为 SubscriptionConfig 以避免与其他可能的 Config 冲突
type SubscriptionConfig struct { // <--- 这里重命名了
	OutputType                 string `json:"output_type"`
	Clash                      string `json:"clash"`
	Surge                      string `json:"surge"`
	Egern                      string `json:"egern"`
	EgernUpdateIntervalMinutes int    `json:"egern_update_interval"`
	UDP                        bool   `json:"udp"`
	Cert                       bool   `json:"cert"`
}

func GenerateSubscriptionToken() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	return hex.EncodeToString(buf)
}

func LegacySubscriptionToken(name string) string {
	sum := md5.Sum([]byte(name))
	return hex.EncodeToString(sum[:])
}

func (sub *Subcription) EnsureToken() {
	if strings.TrimSpace(sub.Token) == "" {
		sub.Token = GenerateSubscriptionToken()
	}
}

func (sub *Subcription) ActiveNodes() []Node {
	nodes := make([]Node, 0, len(sub.Nodes))
	for _, item := range sub.Nodes {
		if !item.Disabled {
			nodes = append(nodes, item)
		}
	}
	return nodes
}

func subscriptionNodeOrderValue(nodes []Node) string {
	values := make([]string, 0, len(nodes))
	for _, node := range nodes {
		values = append(values, strconv.Itoa(node.ID))
	}
	return strings.Join(values, ",")
}

func applySubscriptionNodeOrder(nodes []Node, order string) []Node {
	if strings.TrimSpace(order) == "" || len(nodes) == 0 {
		return nodes
	}
	byID := make(map[string]Node, len(nodes))
	byName := make(map[string]Node, len(nodes))
	used := make(map[int]bool, len(nodes))
	for _, node := range nodes {
		byID[strconv.Itoa(node.ID)] = node
		byName[node.Name] = node
	}
	reordered := make([]Node, 0, len(nodes))
	for _, item := range strings.Split(order, ",") {
		key := strings.TrimSpace(item)
		if key == "" {
			continue
		}
		node, ok := byID[key]
		if !ok {
			node, ok = byName[key]
		}
		if ok && !used[node.ID] {
			reordered = append(reordered, node)
			used[node.ID] = true
		}
	}
	for _, node := range nodes {
		if !used[node.ID] {
			reordered = append(reordered, node)
		}
	}
	return reordered
}

func ValidateSubscriptionIDs(ids []int) error {
	if len(ids) == 0 {
		return nil
	}
	var count int64
	if err := DB.Model(&Subcription{}).Where("id IN ?", ids).Count(&count).Error; err != nil {
		return err
	}
	if count != int64(len(ids)) {
		return errors.New("选择的订阅不存在或已被删除")
	}
	return nil
}

func SetNodeSubscriptions(nodeID int, subscriptionIDs []int) error {
	selected := make(map[int]bool, len(subscriptionIDs))
	for _, id := range subscriptionIDs {
		selected[id] = true
	}

	return DB.Transaction(func(tx *gorm.DB) error {
		var node Node
		if err := tx.First(&node, nodeID).Error; err != nil {
			return err
		}
		var subscriptions []Subcription
		if err := tx.Preload("Nodes").Find(&subscriptions).Error; err != nil {
			return err
		}
		availableSelected := 0
		for _, sub := range subscriptions {
			if selected[sub.ID] {
				availableSelected++
			}
		}
		if availableSelected != len(selected) {
			return errors.New("选择的订阅不存在或已被删除")
		}

		for index := range subscriptions {
			sub := &subscriptions[index]
			sub.Nodes = applySubscriptionNodeOrder(sub.Nodes, sub.NodeOrder)
			containsNode := false
			nextNodes := make([]Node, 0, len(sub.Nodes)+1)
			for _, current := range sub.Nodes {
				if current.ID == nodeID {
					containsNode = true
					if !selected[sub.ID] {
						continue
					}
				}
				nextNodes = append(nextNodes, current)
			}
			if selected[sub.ID] && !containsNode {
				nextNodes = append(nextNodes, node)
			}
			if containsNode == selected[sub.ID] {
				continue
			}

			nodeOrder := subscriptionNodeOrderValue(nextNodes)
			if err := tx.Model(sub).Update("node_order", nodeOrder).Error; err != nil {
				return err
			}
			if err := tx.Model(sub).Association("Nodes").Replace(nextNodes); err != nil {
				return err
			}
		}
		return nil
	})
}

func (sub *Subcription) IsAvailable(now time.Time) (bool, string) {
	if sub.Revoked {
		return false, "订阅链接已失效"
	}
	if sub.ExpireAt != nil && now.After(*sub.ExpireAt) {
		return false, "订阅已过期"
	}
	if sub.AccessLimit > 0 && sub.AccessCount >= sub.AccessLimit {
		return false, "订阅访问次数已用完"
	}
	return true, ""
}

// Add 添加订阅
func (sub *Subcription) Add() error {
	sub.EnsureToken()
	// 在创建订阅时，如果 sub.Nodes 已经被前端填充并排序，可以将其名称转换为 NodeOrder 字符串
	if len(sub.Nodes) > 0 {
		sub.NodeOrder = subscriptionNodeOrderValue(sub.Nodes)
	}

	// 首先创建 Subcription 记录，不包括多对多关系
	if err := DB.Create(sub).Error; err != nil {
		return err
	}
	// 然后建立多对多关系

	// log.Println("Adding subscription nodes:", sub.Nodes)
	return DB.Model(sub).Association("Nodes").Append(sub.Nodes)
}

// Update 更新订阅
func (sub *Subcription) Update(NewName *Subcription) error {
	// 查找现有订阅
	var existingSub Subcription
	if err := DB.Where("id = ? or name = ?", sub.ID, sub.Name).First(&existingSub).Error; err != nil {
		return err // 订阅不存在
	}

	// 更新非多对多字段，包括 NodeOrder
	existingSub.Name = NewName.Name // 新名称
	existingSub.Config = NewName.Config
	existingSub.ExpireAt = NewName.ExpireAt
	existingSub.AccessLimit = NewName.AccessLimit

	// 更新 NodeOrder 字段
	if len(NewName.Nodes) > 0 {
		existingSub.NodeOrder = subscriptionNodeOrderValue(NewName.Nodes)
	} else {
		existingSub.NodeOrder = "" // 如果没有节点，清空
	}

	// 保存更新
	if err := DB.Save(&existingSub).Error; err != nil {
		return err
	}

	// 更新多对多关系: Replace 会清除旧关联并建立新关联
	// 确保 sub.Nodes 包含了新的排序后的节点对象
	return DB.Model(&existingSub).Association("Nodes").Replace(NewName.Nodes)
}

// Find 查找订阅 (通常用于获取单个订阅的详细信息，包括其关联节点和日志)
func (sub *Subcription) Find() error {
	// 使用 Preload 加载 Nodes 和 SubLogs 关联数据
	if err := DB.Preload("Nodes").Preload("SubLogs").Where("id = ? or name = ?", sub.ID, sub.Name).First(sub).Error; err != nil {
		return err
	}
	if strings.TrimSpace(sub.Token) == "" {
		sub.Token = GenerateSubscriptionToken()
		_ = DB.Model(sub).Update("token", sub.Token).Error
	}
	// 根据 NodeOrder 字段重新排序 Nodes
	if sub.NodeOrder != "" && len(sub.Nodes) > 0 {
		sub.Nodes = applySubscriptionNodeOrder(sub.Nodes, sub.NodeOrder)
	}

	return nil
}

// List 订阅列表 (返回所有订阅，并加载其关联节点和日志，按指定顺序)
func (sub *Subcription) List() ([]Subcription, error) {
	var subs []Subcription
	err := DB.Preload("Nodes").Preload("SubLogs").Find(&subs).Error // 预加载所有关联
	if err != nil {
		return nil, err
	}

	for i := range subs {
		if strings.TrimSpace(subs[i].Token) == "" {
			subs[i].Token = GenerateSubscriptionToken()
			_ = DB.Model(&subs[i]).Update("token", subs[i].Token).Error
		}
		// 根据 NodeOrder 字段重新排序每个订阅的 Nodes
		if subs[i].NodeOrder != "" && len(subs[i].Nodes) > 0 {
			subs[i].Nodes = applySubscriptionNodeOrder(subs[i].Nodes, subs[i].NodeOrder)
		}
	}
	return subs, nil
}

// IPlogUpdate 更新订阅日志 (与节点排序无关，保持不变)
func (sub *Subcription) IPlogUpdate() error {
	return DB.Model(sub).Association("SubLogs").Replace(&sub.SubLogs)
}

// Del 删除订阅 (与节点排序无关，保持不变)
func (sub *Subcription) Del() error {
	// 清除多对多关系
	err := DB.Model(sub).Association("Nodes").Clear()
	if err != nil {
		return err
	}
	// 删除主记录，由于 SubLogs 使用 foreignKey，理论上 GORM 应该能级联删除子记录。
	// 但为了确保，你也可以显式删除 SubLogs:
	// DB.Where("subcription_id = ?", sub.ID).Delete(&SubLogs{})
	return DB.Delete(sub).Error
}

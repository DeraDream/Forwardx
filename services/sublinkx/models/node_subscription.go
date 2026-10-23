package models

import (
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"
)

type NodeSubscription struct {
	gorm.Model
	ID          int
	Name        string
	NodeOrder   string `gorm:"type:text"`
	Token       string `gorm:"index"`
	Revoked     bool
	ExpireAt    *time.Time
	AccessLimit int
	AccessCount int
	Nodes       []Node `gorm:"many2many:node_subscription_nodes;"`
}

func (sub *NodeSubscription) EnsureToken() {
	if strings.TrimSpace(sub.Token) == "" {
		sub.Token = GenerateSubscriptionToken()
	}
}

func (sub *NodeSubscription) ActiveNodes() []Node {
	nodes := make([]Node, 0, len(sub.Nodes))
	for _, item := range sub.Nodes {
		if !item.Disabled {
			nodes = append(nodes, item)
		}
	}
	return nodes
}

func (sub *NodeSubscription) IsAvailable(now time.Time) (bool, string) {
	if sub.Revoked {
		return false, "节点订阅链接已失效"
	}
	if sub.ExpireAt != nil && now.After(*sub.ExpireAt) {
		return false, "节点订阅已过期"
	}
	if sub.AccessLimit > 0 && sub.AccessCount >= sub.AccessLimit {
		return false, "节点订阅访问次数已用完"
	}
	return true, ""
}

func (sub *NodeSubscription) applyNodeOrder() {
	if strings.TrimSpace(sub.NodeOrder) == "" || len(sub.Nodes) == 0 {
		return
	}
	byID := make(map[string]Node, len(sub.Nodes))
	byName := make(map[string]Node, len(sub.Nodes))
	used := make(map[int]bool, len(sub.Nodes))
	for _, node := range sub.Nodes {
		byID[strconv.Itoa(node.ID)] = node
		byName[node.Name] = node
	}
	reorderedNodes := make([]Node, 0, len(sub.Nodes))
	for _, item := range strings.Split(sub.NodeOrder, ",") {
		key := strings.TrimSpace(item)
		if key == "" {
			continue
		}
		node, ok := byID[key]
		if !ok {
			node, ok = byName[key]
		}
		if ok && !used[node.ID] {
			reorderedNodes = append(reorderedNodes, node)
			used[node.ID] = true
		}
	}
	for _, node := range sub.Nodes {
		if !used[node.ID] {
			reorderedNodes = append(reorderedNodes, node)
		}
	}
	sub.Nodes = reorderedNodes
}

func nodeIDsFromNodes(nodes []Node) string {
	values := make([]string, 0, len(nodes))
	for _, node := range nodes {
		values = append(values, strconv.Itoa(node.ID))
	}
	return strings.Join(values, ",")
}

func (sub *NodeSubscription) Add() error {
	sub.EnsureToken()
	if len(sub.Nodes) > 0 {
		sub.NodeOrder = nodeIDsFromNodes(sub.Nodes)
	}
	if err := DB.Create(sub).Error; err != nil {
		return err
	}
	return DB.Model(sub).Association("Nodes").Append(sub.Nodes)
}

func (sub *NodeSubscription) Update(next *NodeSubscription) error {
	var existing NodeSubscription
	if err := DB.Where("id = ? or name = ?", sub.ID, sub.Name).First(&existing).Error; err != nil {
		return err
	}
	existing.Name = next.Name
	existing.ExpireAt = next.ExpireAt
	existing.AccessLimit = next.AccessLimit
	if len(next.Nodes) > 0 {
		existing.NodeOrder = nodeIDsFromNodes(next.Nodes)
	} else {
		existing.NodeOrder = ""
	}
	if err := DB.Save(&existing).Error; err != nil {
		return err
	}
	return DB.Model(&existing).Association("Nodes").Replace(next.Nodes)
}

func (sub *NodeSubscription) Find() error {
	if err := DB.Preload("Nodes").Where("id = ? or name = ? or token = ?", sub.ID, sub.Name, sub.Token).First(sub).Error; err != nil {
		return err
	}
	sub.EnsureToken()
	if err := DB.Model(sub).Update("token", sub.Token).Error; err != nil {
		return err
	}
	sub.applyNodeOrder()
	return nil
}

func (sub *NodeSubscription) List() ([]NodeSubscription, error) {
	var subs []NodeSubscription
	if err := DB.Preload("Nodes").Find(&subs).Error; err != nil {
		return nil, err
	}
	for i := range subs {
		if strings.TrimSpace(subs[i].Token) == "" {
			subs[i].Token = GenerateSubscriptionToken()
			_ = DB.Model(&subs[i]).Update("token", subs[i].Token).Error
		}
		subs[i].applyNodeOrder()
	}
	return subs, nil
}

func (sub *NodeSubscription) Del() error {
	if err := DB.Model(sub).Association("Nodes").Clear(); err != nil {
		return err
	}
	return DB.Delete(sub).Error
}

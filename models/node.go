package models

import (
	"errors"
	"log"

	"gorm.io/gorm"
)

type GroupNode struct {
	gorm.Model
	ID    int
	Name  string
	Nodes []Node `gorm:"many2many:group_node_nodes"` // 多对多关联字段
}

type Node struct {
	gorm.Model
	ID                    int
	Name                  string
	Link                  string
	Disabled              bool
	GroupNodes            []GroupNode `gorm:"many2many:group_node_nodes"` // 反向关联字段
}

// hook Node 写入创建删除修改 等写入权限
func (n *Node) AfterSave(*gorm.DB) error {
	// 写操作前执行（Create 或 Update）

	return nil
}

// 创建分组
func (gn *GroupNode) Add() error {
	// 检查分组是否已存在
	var existingGroup GroupNode
	result := DB.Model(gn).Where("name = ?", gn.Name).First(&existingGroup) // 查询数据库中是否存在同名的分组
	if result.Error != nil && !errors.Is(result.Error, gorm.ErrRecordNotFound) {
		log.Println(result.Error)
		return result.Error // 如果查询出错，返回错误
	}
	if result.RowsAffected > 0 { // 如果查询到分组已存在
		// log.Println("分组已存在")
		return nil // 不返回错误存在就跳过

	}
	return DB.FirstOrCreate(gn, GroupNode{Name: gn.Name}).Error
}

// 关联分组
func (gn *GroupNode) Ass(n *Node) error {
	result := DB.Model(gn).Where("name = ?", gn.Name).First(gn) // 查找分组
	// log.Println("分组ID:", gn.ID, "分组昵称:", gn.Name, "错误信息:", result.Error)
	if result.Error != nil {
		log.Println(result.Error)
	}
	result = DB.Model(n).Where("name = ?", n.Name).First(n) // 查找节点
	// log.Println("节点ID:", n.ID, "节点昵称:", n.Name, "错误信息:", result.Error)
	if result.Error != nil {
		log.Println(result.Error)
	}
	return DB.Model(&gn).Association("Nodes").Append(n)
}

// 更新分组信息
func (gn *GroupNode) Update(NewGn *GroupNode) error {
	// 读取分组数据
	var FirstGn GroupNode
	result := DB.Model(gn).Where("id = ? or name = ?", NewGn.ID, NewGn.Name).First(&FirstGn)
	if result.Error != nil {
		log.Println(result.Error)
		return result.Error
	}
	if result.RowsAffected > 0 {
		return errors.New("分组已存在")
	}
	return DB.Model(gn).Where("id = ? or name = ?", gn.ID, gn.Name).Updates(&NewGn).Error
}

// 删除分组
func (gn *GroupNode) Del() error {
	// 读取分组数据
	result := DB.Model(gn).Where("id = ? or name = ?", gn.ID, gn.Name).First(&gn)
	if result.Error != nil {
		log.Println(result.Error)
		return result.Error
	}
	// 读取分组关联的节点数据
	result = DB.Model(gn).Preload("Nodes").First(gn) // 预加载分组关联的节点数据
	if result.Error != nil {
		log.Println(result.Error)
		return result.Error
	}
	log.Println(gn.Nodes)
	err := DB.Model(gn).Association("Nodes").Delete(gn.Nodes)
	if err != nil {
		log.Println("解除关联失败", err)
		return err
	}
	return DB.Model(gn).Where("id = ? or name = ?", gn.ID, gn.Name).Delete(gn).Error // 删除分组记录
}

// 查看所有分组

func GetGroupNodeList() ([]GroupNode, error) {
	var gns []GroupNode
	result := DB.Model(gns).Select("id", "name").Order("name asc").Find(&gns)
	if result.Error != nil {
		return nil, errors.New("没有任何分组")
	}
	return gns, result.Error
}

/* 下面为节点的增删改查 */

// 添加节点的方法
func (n *Node) Add() error {
	// 检查节点是否已存在
	var existingNode Node
	result := DB.Model(n).Where("link = ? and name =?", n.Link, n.Name).First(&existingNode) // 查询数据库中是否存在同名同链接的节点
	if result.Error != nil && !errors.Is(result.Error, gorm.ErrRecordNotFound) {
		return result.Error // 如果查询出错，返回错误
	}
	if result.RowsAffected > 0 {
		// log.Println("节点已经存在")
		return nil // 如果节点已经存在就跳过
	}
	return DB.Model(n).Create(n).Error // 使用 GORM 创建新的节点记录
}

// 删除节点
func (n *Node) Del() error {
	// 查看是否有关联 有的话解除关联
	DB.Model(n).Preload("GroupNodes").First(n) // 预加载分组节点
	gns := n.GroupNodes

	if len(n.GroupNodes) > 0 {
		err := DB.Model(n).Association("GroupNodes").Delete(n.GroupNodes)
		if err != nil {
			return err
		}
	}
	IsGroupNotDel(gns)
	// 如果分组节点没有关联的节点则删除分组节点
	// for _, gn := range gns {
	// 	DB.Model(gn).Preload("Nodes").Find(&gn) // 预加载分组节点数据
	// 	log.Println("gnNodes:", gn.Nodes)
	// 	if len(gn.Nodes) == 0 {
	// 		// log.Println("分组节点没有关联的节点，删除分组节点", gn.Name)
	// 		err := DB.Model(gn).Delete(&gn).Error // 删除分组节点
	// 		if err != nil {
	// 			log.Println("删除分组节点失败", err)
	// 			return err
	// 		}
	// 	}
	// }
	// Unscoped  硬删除
	// 默认删除是软删除 数据库仍然存在记录
	return DB.Model(n).Delete(n).Error
}

// 更新节点

func (n *Node) UpdateNode(New *Node) error {
	// 检查节点是否已存在
	var n1 Node
	result := DB.Model(n).Where("id = ?", New.ID).First(&n1) // 查询数据库中是否存在同名同链接的节点
	if result.Error != nil && !errors.Is(result.Error, gorm.ErrRecordNotFound) {
		log.Println(result.Error)
		return result.Error // 如果查询出错，返回错误

	}
	if result.RowsAffected > 0 {
		log.Println("节点已经存在", result.Error)
		return errors.New("节点已经存在") // 如果查询出错，返回错误
	}
	// 更新记录
	return DB.Model(n).Where("id = ?", n.ID).Updates(New).Error
}

// 检查分组无绑定则删除
func IsGroupNotDel(gns []GroupNode) error {
	// 如果分组节点没有关联的节点则删除分组节点
	for _, gn := range gns {
		DB.Model(gn).Preload("Nodes").Find(&gn) // 预加载分组节点数据
		// log.Println("gnNodes:", gn.Nodes, "长度:", len(gn.Nodes))
		if len(gn.Nodes) == 0 {
			// log.Println("分组节点没有关联的节点，删除分组节点", gn.Name)
			err := DB.Model(gn).Delete(&gn).Error // 删除分组节点
			if err != nil {
				log.Println("删除分组节点失败", err)
				return err
			}
		}
	}
	return nil
}

// 更新关联分组

func (n *Node) UpdateGroup(gns []GroupNode) error {
	// 检测节点是否存在
	result := DB.Model(n).Where("id = ? or name = ?", n.ID, n.Name).First(&n) // 查找节点
	if result.Error != nil {
		log.Println(result.Error)
		return result.Error // 如果查询出错，返回错误
	}

	// 检查分组是否已存在
	var NewGroupDatas []GroupNode

	for _, gn := range gns {

		// var NewGroupData GroupNode

		if gn.Name == "" {

			// 预加载关联
			result := DB.Model(n).Preload("GroupNodes").First(n) // 预加载分组节点
			if result.Error != nil {
				log.Println(result.Error)
				return result.Error // 如果查询出错，返回错误
			}
			IsGroupNot := n.GroupNodes // 临时分组节点切片
			log.Println("NewGroupDatas", IsGroupNot)

			// 解除关联
			// log.Println("分组名称为空,解除关联", NewGroup)
			err := DB.Model(n).Association("GroupNodes").Clear()
			if err != nil {
				log.Println("解除关联失败", err)
				return err
			}
			//

			err = IsGroupNotDel(IsGroupNot) // 检查分组节点是否有绑定的节点，如果没有则删除分组节点
			if err != nil {
				log.Println(err)
				// return err // 如果检查分组节点失败，返回错误
			}
			return nil
		}
		result := DB.Model(gn).Where("name = ?", gn.Name).First(&gn) // 查找分组
		// 没有找到记录
		if result.Error != nil && !errors.Is(result.Error, gorm.ErrRecordNotFound) {
			log.Println(result.Error)
			return result.Error // 如果查询出错，返回错误
		}
		NewGroupDatas = append(NewGroupDatas, gn) // 将新的数据添加到更新列表中
	}

	// 更新记录
	return DB.Model(n).Association("GroupNodes").Replace(NewGroupDatas) // 替换分组节点
}

// 查看所有节点

func GetNodeList() ([]Node, error) {
	var ns []Node
	result := DB.Model(ns).Preload("GroupNodes", func(db *gorm.DB) *gorm.DB {
		return db.Select("group_nodes.id", "group_nodes.name")
	}).Order("nodes.id desc").Find(&ns)
	if result.Error != nil {
		return nil, result.Error
	}
	return ns, result.Error
}

func GetNodeListPage(page, pageSize int, group string) ([]Node, int64, error) {
	var ns []Node
	var total int64
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}

	query := DB.Model(&Node{}).Where("nodes.deleted_at IS NULL")
	if group != "" && group != "全部" {
		query = query.
			Joins("JOIN group_node_nodes ON group_node_nodes.node_id = nodes.id").
			Joins("JOIN group_nodes ON group_nodes.id = group_node_nodes.group_node_id").
			Where("group_nodes.deleted_at IS NULL").
			Where("group_nodes.name = ?", group)
	}

	if err := query.Distinct("nodes.id").Count(&total).Error; err != nil {
		return nil, 0, err
	}
	err := query.
		Distinct("nodes.*").
		Order("nodes.id desc").
		Limit(pageSize).
		Offset((page - 1) * pageSize).
		Find(&ns).Error
	if err != nil || len(ns) == 0 {
		return ns, total, err
	}

	ids := make([]int, 0, len(ns))
	byID := make(map[int]*Node, len(ns))
	for i := range ns {
		ids = append(ids, ns[i].ID)
		byID[ns[i].ID] = &ns[i]
	}
	var groups []struct {
		NodeID    int
		GroupID   int
		GroupName string
	}
	if err := DB.Table("group_node_nodes").
		Select("group_node_nodes.node_id, group_nodes.id AS group_id, group_nodes.name AS group_name").
		Joins("JOIN group_nodes ON group_nodes.id = group_node_nodes.group_node_id").
		Where("group_nodes.deleted_at IS NULL").
		Where("group_node_nodes.node_id IN ?", ids).
		Order("group_nodes.name asc").
		Scan(&groups).Error; err != nil {
		return nil, 0, err
	}
	for _, item := range groups {
		if node, ok := byID[item.NodeID]; ok {
			node.GroupNodes = append(node.GroupNodes, GroupNode{
				ID:   item.GroupID,
				Name: item.GroupName,
			})
		}
	}
	return ns, total, nil
}

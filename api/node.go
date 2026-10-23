package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"sublink/models"
	"sublink/node"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const (
	nodeTransferVersion = 1
	maxNodeImportSize   = 5 << 20
)

type nodeTransferFile struct {
	Version    int                `json:"version"`
	ExportedAt time.Time          `json:"exported_at"`
	Nodes      []nodeTransferNode `json:"nodes"`
}

type nodeTransferNode struct {
	Name     string   `json:"name"`
	Link     string   `json:"link"`
	Disabled bool     `json:"disabled"`
	Groups   []string `json:"groups"`
}

func DocodeNodeName(nd *models.Node) (models.Node, error) { // 解码节点名称
	nd.Name = strings.TrimSpace(nd.Name)
	if nd.Name == "" {
		u, err := url.Parse(nd.Link)
		if err != nil {
			log.Println(err)
			return *nd, err
		}
		switch {
		case u.Scheme == "ss":
			ss, err := node.DecodeSSURL(nd.Link)
			if err != nil {
				log.Println(err)
				return *nd, err
			}
			nd.Name = ss.Name
		case u.Scheme == "ssr":
			ssr, err := node.DecodeSSRURL(nd.Link)
			if err != nil {
				log.Println(err)
				return *nd, err
			}
			nd.Name = ssr.Qurey.Remarks
		case u.Scheme == "trojan":
			trojan, err := node.DecodeTrojanURL(nd.Link)
			if err != nil {
				log.Println(err)
				return *nd, err
			}
			nd.Name = trojan.Name
		case u.Scheme == "vmess":
			vmess, err := node.DecodeVMESSURL(nd.Link)
			if err != nil {
				log.Println(err)
				return *nd, err
			}
			nd.Name = vmess.Ps

		case u.Scheme == "vless":
			vless, err := node.DecodeVLESSURL(nd.Link)
			if err != nil {
				log.Println(err)
				return *nd, err
			}
			nd.Name = vless.Name
		case u.Scheme == "hy" || u.Scheme == "hysteria":
			hy, err := node.DecodeHYURL(nd.Link)
			if err != nil {
				log.Println(err)
				return *nd, err
			}
			nd.Name = hy.Name
		case u.Scheme == "hy2" || u.Scheme == "hysteria2":
			hy2, err := node.DecodeHY2URL(nd.Link)
			if err != nil {
				log.Println(err)
				return *nd, err
			}
			nd.Name = hy2.Name
		case u.Scheme == "tuic":
			tuic, err := node.DecodeTuicURL(nd.Link)
			if err != nil {
				log.Println(err)
				return *nd, err
			}
			nd.Name = tuic.Name
		}
	}
	return *nd, nil
}
func NodeUpdadte(c *gin.Context) {
	// var node models.Node
	NewName := strings.TrimSpace(c.PostForm("name"))
	Newlink := strings.TrimSpace(c.PostForm("link"))
	if replacementID := strings.TrimSpace(c.PostForm("replace_ip_id")); replacementID != "" {
		entry, ok := findReplacementIP(c, replacementID)
		if !ok {
			return
		}
		replacement, err := node.ReplaceServerAddress(Newlink, entry.Address)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
			return
		}
		Newlink = replacement.Link
	}
	id := c.PostForm("id")
	subscriptionIDs, updateSubscriptions, err := nodeSubscriptionIDs(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	if updateSubscriptions {
		if err := models.ValidateSubscriptionIDs(subscriptionIDs); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
			return
		}
	}
	group := c.PostForm("group")        // 分组
	groups := strings.Split(group, ",") // 分组列表
	index, err := strconv.Atoi(id)
	if err != nil {
		c.JSON(400, gin.H{
			"msg": "id 不能为空或者格式不正确",
		})
		return

	}
	if NewName == "" || Newlink == "" {
		c.JSON(400, gin.H{
			"msg": "节点名称 or 备注不能为空",
		})
		return
	}
	OldNode := &models.Node{
		ID: index,
	}
	NewNode := &models.Node{
		Name: NewName,
		Link: Newlink,
	}
	var gns []models.GroupNode
	if groups != nil || len(groups) > 0 {
		for _, g := range groups {
			TempGn := models.GroupNode{
				Name: strings.TrimSpace(g), // 去除分组名称两端空格
			}
			gns = append(gns, TempGn) // 生成分组列表
		}

	}
	err = OldNode.UpdateGroup(gns) // 更新分组
	if err != nil {
		c.JSON(400, gin.H{
			"msg": fmt.Sprintf("更新失败: %s", err.Error()),
		})
		return
	}
	err = OldNode.UpdateNode(NewNode)
	if err != nil {
		c.JSON(400, gin.H{
			"msg": fmt.Sprintf("更新失败: %s", err.Error()),
		})
		return
	}
	if updateSubscriptions {
		if err := models.SetNodeSubscriptions(index, subscriptionIDs); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"msg": fmt.Sprintf("更新订阅关联失败: %s", err.Error())})
			return
		}
	}
	clearSubscriptionCache()

	c.JSON(200, gin.H{
		"code": "00000",
		"msg":  "更新成功",
	})
}

// 获取节点列表
func NodeGet(c *gin.Context) {
	if c.Query("all") == "1" {
		var ns []models.Node
		ns, err := models.GetNodeList()
		if err != nil {
			c.JSON(500, gin.H{
				"msg": "node list error",
			})
			return
		}
		c.JSON(200, gin.H{
			"code": "00000",
			"data": ns,
			"msg":  "node get",
		})
		return
	}

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	group := strings.TrimSpace(c.Query("group"))
	ns, total, err := models.GetNodeListPage(page, pageSize, group)
	if err != nil {
		c.JSON(500, gin.H{
			"msg": "node list error",
		})
		return
	}
	c.JSON(200, gin.H{
		"code": "00000",
		"data": gin.H{
			"items":     ns,
			"total":     total,
			"page":      page,
			"page_size": pageSize,
		},
		"msg": "node get",
	})
}

// NodeExport downloads a portable JSON backup of all nodes and their groups.
func NodeExport(c *gin.Context) {
	nodes, err := models.GetNodeList()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "node export error"})
		return
	}

	payload := nodeTransferFile{
		Version:    nodeTransferVersion,
		ExportedAt: time.Now().UTC(),
		Nodes:      make([]nodeTransferNode, 0, len(nodes)),
	}
	for _, item := range nodes {
		groups := make([]string, 0, len(item.GroupNodes))
		for _, group := range item.GroupNodes {
			groups = append(groups, group.Name)
		}
		payload.Nodes = append(payload.Nodes, nodeTransferNode{
			Name:     item.Name,
			Link:     item.Link,
			Disabled: item.Disabled,
			Groups:   groups,
		})
	}

	c.Header("Cache-Control", "no-store")
	c.Header("Content-Disposition", "attachment; filename=\"sublink-nodes.json\"")
	c.JSON(http.StatusOK, payload)
}

// NodeImport restores nodes from a NodeExport JSON file. Invalid files are rejected
// before data is written, and existing name/link pairs are left untouched.
func NodeImport(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxNodeImportSize)
	file, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "请选择节点导出文件"})
		return
	}
	if file.Size > maxNodeImportSize {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"msg": "导入文件不能超过 5 MB"})
		return
	}

	source, err := file.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "无法读取导入文件"})
		return
	}
	defer source.Close()

	var payload nodeTransferFile
	decoder := json.NewDecoder(io.LimitReader(source, maxNodeImportSize))
	if err := decoder.Decode(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "导入文件不是有效的节点备份 JSON"})
		return
	}
	if payload.Version != nodeTransferVersion {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "不支持的节点备份版本"})
		return
	}
	if len(payload.Nodes) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "导入文件中没有节点"})
		return
	}
	if len(payload.Nodes) > 1000 {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "单次最多导入 1000 个节点"})
		return
	}

	for index := range payload.Nodes {
		item := &payload.Nodes[index]
		item.Name = strings.TrimSpace(item.Name)
		item.Link = strings.TrimSpace(item.Link)
		if item.Link == "" || !strings.Contains(item.Link, "://") {
			c.JSON(http.StatusBadRequest, gin.H{"msg": fmt.Sprintf("第 %d 个节点链接格式不正确", index+1)})
			return
		}
		decoded, err := DocodeNodeName(&models.Node{Name: item.Name, Link: item.Link})
		if err != nil || strings.TrimSpace(decoded.Name) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"msg": fmt.Sprintf("第 %d 个节点无法解析", index+1)})
			return
		}
		item.Name = decoded.Name
		item.Groups = uniqueGroupNames(item.Groups)
	}

	created := 0
	skipped := 0
	err = models.DB.Transaction(func(tx *gorm.DB) error {
		for _, item := range payload.Nodes {
			var existing models.Node
			err := tx.Where("link = ? AND name = ?", item.Link, item.Name).First(&existing).Error
			if err == nil {
				skipped++
				continue
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}

			createdNode := models.Node{Name: item.Name, Link: item.Link, Disabled: item.Disabled}
			if err := tx.Create(&createdNode).Error; err != nil {
				return err
			}
			for _, groupName := range item.Groups {
				var group models.GroupNode
				if err := tx.Where("name = ?", groupName).First(&group).Error; err != nil {
					if !errors.Is(err, gorm.ErrRecordNotFound) {
						return err
					}
					group = models.GroupNode{Name: groupName}
					if err := tx.Create(&group).Error; err != nil {
						return err
					}
				}
				if err := tx.Model(&createdNode).Association("GroupNodes").Append(&group); err != nil {
					return err
				}
			}
			created++
		}
		return nil
	})
	if err != nil {
		log.Printf("node import failed: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "节点导入失败"})
		return
	}
	clearSubscriptionCache()
	c.JSON(http.StatusOK, gin.H{
		"code": "00000",
		"data": gin.H{"created": created, "skipped": skipped},
		"msg":  "节点导入完成",
	})
}

func uniqueGroupNames(groups []string) []string {
	seen := make(map[string]struct{}, len(groups))
	result := make([]string, 0, len(groups))
	for _, group := range groups {
		name := strings.TrimSpace(group)
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	return result
}

// 获取分组列表
func GroupNodeGet(c *gin.Context) {
	var Gns []models.GroupNode
	Gns, err := models.GetGroupNodeList()
	var data []string
	for _, g := range Gns {
		data = append(data, g.Name)
	}
	if err != nil {
		c.JSON(400, gin.H{
			"msg": err.Error(),
		})
		return
	}
	c.JSON(200, gin.H{
		"code": "00000",
		"data": data,
		"msg":  "GroupNode get",
	})
}

// 设置关联分组
func GroupNodeSet(c *gin.Context) {
	// var n models.Node
	var gns []models.GroupNode
	var FirstGroup models.GroupNode
	name := c.PostForm("name")
	group := c.PostForm("group")

	// 将group分割成多个分组
	groups := strings.Split(group, ",")
	if len(groups) == 0 {
		c.JSON(400, gin.H{
			"msg": "分组不能为空",
		})
		return
	}
	log.Println("分组列表:", groups, "数组长度", len(groups))

	// 循环生成或绑定分组
	for _, g := range groups {
		// 如果group为空，跳过
		if strings.TrimSpace(g) == "" {
			log.Println("分组名为空，跳过")
			continue
		}
		log.Println("分组名:", g)
		FirstGroup.Name = g
		err := FirstGroup.Add()
		if err != nil {
			log.Println("添加分组失败:", err)
			c.JSON(400, gin.H{
				"msg": err.Error(),
			})
			return
		}
		// 查找分组并将数据FirstGroup填充 并且插入给gns
		result := models.DB.Model(models.GroupNode{}).Where("name = ?", g).First(&FirstGroup)
		log.Println("FirstGroup", FirstGroup)
		if result.Error != nil && !errors.Is(result.Error, gorm.ErrRecordNotFound) {
			log.Println(result.Error)
			c.JSON(400, gin.H{
				"msg": result.Error,
			})
			return
		}
		gns = append(gns, FirstGroup)
	}

	n := models.Node{Name: name}
	err := n.UpdateGroup(gns)
	if err != nil {
		c.JSON(400, gin.H{
			"msg": err.Error(),
		})
		return
	}
	c.JSON(200, gin.H{
		"code": "00000",
		"msg":  "更新关联分组成功",
	})
}

func nodeSubscriptionIDs(c *gin.Context) ([]int, bool, error) {
	raw, exists := c.GetPostForm("subscription_ids")
	if !exists {
		return nil, false, nil
	}
	ids := make([]int, 0)
	seen := make(map[int]bool)
	for _, value := range strings.Split(raw, ",") {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		id, err := strconv.Atoi(value)
		if err != nil || id <= 0 {
			return nil, true, fmt.Errorf("订阅 ID 格式不正确: %s", value)
		}
		if !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	return ids, true, nil
}

// 添加节点
func NodeAdd(c *gin.Context) {
	var n models.Node
	link := strings.TrimSpace(c.PostForm("link"))
	name := strings.TrimSpace(c.PostForm("name"))
	group := c.PostForm("group")
	subscriptionIDs, updateSubscriptions, err := nodeSubscriptionIDs(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	if updateSubscriptions {
		if err := models.ValidateSubscriptionIDs(subscriptionIDs); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
			return
		}
	}
	if replacementID := strings.TrimSpace(c.PostForm("replace_ip_id")); replacementID != "" {
		entry, ok := findReplacementIP(c, replacementID)
		if !ok {
			return
		}
		replacement, err := node.ReplaceServerAddress(link, entry.Address)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
			return
		}
		link = replacement.Link
	}
	n = models.Node{
		Name: name,
		Link: link,
	}
	if link == "" || !strings.Contains(link, "://") {
		c.JSON(400, gin.H{
			"msg": "link不能为空或者格式不正确,请检查链接是否包含协议头,例如 http:// 或 https://",
		})
		return
	}
	// 解码节点名称
	n, err = DocodeNodeName(&n)
	if err != nil {
		log.Println("解码节点名称错误:", err)
		c.JSON(400, gin.H{
			"msg": "解码节点名称错误",
		})
		return
	}

	// 添加节点
	err = n.Add()
	if err != nil {
		log.Println("添加节点失败:", err)
		c.JSON(400, gin.H{
			"msg": err.Error(),
		})
		return
	}

	// 关联分组开始
	if strings.TrimSpace(group) != "" { // 去除空格后判断分组是否为空
		groups := strings.Split(group, ",") // 允许多个分组用逗号分隔
		if groups != nil || len(groups) > 0 {
			for _, g := range groups {
				gn := &models.GroupNode{Name: g}
				err = gn.Add()
				if err != nil {
					// 分组不存在
					log.Println(err)
					c.JSON(400, gin.H{
						"msg": err,
					})
					return
				}
				// 分组存在，关联节点
				if err := gn.Ass(&n); err != nil {
					log.Println("关联失败:", err)
					c.JSON(400, gin.H{
						"msg": err,
					})
					return
				}

			}
		}
	}
	//关联分组结束
	if updateSubscriptions {
		if err := models.SetNodeSubscriptions(n.ID, subscriptionIDs); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"msg": "关联订阅失败: " + err.Error()})
			return
		}
	}
	clearSubscriptionCache()

	c.JSON(200, gin.H{
		"code": "00000",
		"data": n,
		"msg":  "添加成功",
	})
}

// 删除节点
func NodeDel(c *gin.Context) {
	var n models.Node
	id := c.Query("id")
	if id == "" {
		c.JSON(400, gin.H{
			"msg": "id 不能为空",
		})
		return
	}
	x, _ := strconv.Atoi(id)
	n.ID = x
	err := n.Del()
	if err != nil {
		c.JSON(400, gin.H{
			"msg": "删除失败",
		})
		return
	}
	clearSubscriptionCache()
	c.JSON(200, gin.H{
		"code": "00000",
		"msg":  "删除成功",
	})
}

func NodeSetDisabled(c *gin.Context) {
	id, err := strconv.Atoi(c.PostForm("id"))
	if err != nil || id <= 0 {
		c.JSON(400, gin.H{"msg": "id 不能为空"})
		return
	}
	disabled := c.PostForm("disabled") == "true"
	if err := models.DB.Model(&models.Node{}).Where("id = ?", id).Update("disabled", disabled).Error; err != nil {
		c.JSON(500, gin.H{"msg": err.Error()})
		return
	}
	clearSubscriptionCache()
	c.JSON(200, gin.H{
		"code": "00000",
		"msg":  "节点状态已更新",
	})
}

// 删除分组
func NodesGroup(c *gin.Context) {
	var gn models.GroupNode
	id := c.Query("id")
	if id == "" {
		c.JSON(400, gin.H{
			"msg": "id 不能为空",
		})
		return
	}
	x, _ := strconv.Atoi(id)
	gn.ID = x
	err := gn.Del()
	if err != nil {
		c.JSON(400, gin.H{
			"msg": "删除失败",
		})
		return
	}
	c.JSON(200, gin.H{
		"code": "00000",
		"msg":  "删除成功",
	})
}

// 节点统计
func NodesTotal(c *gin.Context) {
	var nodes []models.Node
	nodes, err := models.GetNodeList()
	count := len(nodes)
	if err != nil {
		c.JSON(500, gin.H{
			"msg": "获取不到节点统计",
		})
		return
	}
	c.JSON(200, gin.H{
		"code": "00000",
		"data": count,
		"msg":  "取得节点统计",
	})
}

// api/subcription.go

package api

import (
	// 导入 json 包，用于解析 config 字符串

	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sublink/models" // 导入 models 包
	"time"

	"github.com/gin-gonic/gin"
)

func SubTotal(c *gin.Context) {
	var Sub models.Subcription
	subs, err := Sub.List()
	count := len(subs)
	if err != nil {
		c.JSON(500, gin.H{
			"msg": "取得订阅总数失败",
		})
		return
	}
	c.JSON(200, gin.H{
		"code": "00000",
		"data": count,
		"msg":  "取得订阅总数",
	})
}

// 获取订阅列表
func SubGet(c *gin.Context) {
	var Sub models.Subcription
	Subs, err := Sub.List()
	if err != nil {
		c.JSON(500, gin.H{
			"msg": "node list error",
		})
		return
	}
	c.JSON(200, gin.H{
		"code": "00000",
		"data": Subs,
		"msg":  "node get",
	})
}

// 添加订阅
func buildNodesFromRefs(nodes string) ([]models.Node, error) {
	var nodesData []models.Node
	for _, item := range strings.Split(nodes, ",") {
		ref := strings.TrimSpace(item)
		if ref == "" {
			continue
		}
		var firstNode models.Node
		if id, err := strconv.Atoi(ref); err == nil && id > 0 {
			if err := models.DB.First(&firstNode, id).Error; err != nil {
				return nil, err
			}
		} else {
			if err := models.DB.Model(models.Node{}).Where("name = ?", ref).First(&firstNode).Error; err != nil {
				return nil, err
			}
		}
		nodesData = append(nodesData, firstNode)
	}
	return nodesData, nil
}

func SubAdd(c *gin.Context) {
	name := c.PostForm("name")
	configs := c.PostForm("config") // 这里的 configString 是前端传来的 JSON 字符串
	nodes := c.PostForm("nodes")
	expireAt, err := parseExpireAt(c.PostForm("expire_at"))
	if err != nil {
		c.JSON(400, gin.H{"msg": "过期时间格式不正确"})
		return
	}
	accessLimit, err := parseOptionalInt(c.PostForm("access_limit"))
	if err != nil {
		c.JSON(400, gin.H{"msg": "访问次数限制格式不正确"})
		return
	}

	if name == "" || nodes == "" {
		c.JSON(400, gin.H{
			"msg": "订阅名称或节点不能为空",
		})
		return
	}

	// 1. 根据 nodesString 字符串，构建 models.Node 数组
	NodesData, err := buildNodesFromRefs(nodes)
	if err != nil {
		c.JSON(400, gin.H{
			"msg": err.Error(),
		})
		return
	}

	sub := models.Subcription{
		Name:        name,
		Config:      configs,     // 这里直接赋值字符串
		NodeOrder:   nodes,       // 这里直接赋值字符串
		ExpireAt:    expireAt,    // 订阅过期时间
		AccessLimit: accessLimit, // 访问次数限制，0 表示不限
		Nodes:       NodesData,   // 这里直接赋值 nodes 数组

	}
	err = sub.Add()
	if err != nil {
		c.JSON(400, gin.H{
			"msg": "添加订阅失败: " + err.Error(),
		})
		return
	}
	clearSubscriptionCache()

	c.JSON(200, gin.H{
		"code": "00000",
		"msg":  "添加订阅成功",
	})
}

// 更新订阅
func SubUpdate(c *gin.Context) {
	NewName := c.PostForm("name")
	OldName := c.PostForm("oldname")
	configs := c.PostForm("config") // 这里的 configString 是前端传来的 JSON 字符串
	nodes := c.PostForm("nodes")
	expireAt, err := parseExpireAt(c.PostForm("expire_at"))
	if err != nil {
		c.JSON(400, gin.H{"msg": "过期时间格式不正确"})
		return
	}
	accessLimit, err := parseOptionalInt(c.PostForm("access_limit"))
	if err != nil {
		c.JSON(400, gin.H{"msg": "访问次数限制格式不正确"})
		return
	}

	if NewName == "" || nodes == "" {
		c.JSON(400, gin.H{
			"msg": "订阅名称或节点不能为空",
		})
		return
	}

	// 1. 根据 nodesString 字符串，构建 models.Node 数组
	NodesData, err := buildNodesFromRefs(nodes)
	if err != nil {
		c.JSON(400, gin.H{
			"msg": err.Error(),
		})
		return
	}

	OldSub := models.Subcription{
		Name: OldName,
	}
	NewSub := models.Subcription{
		Name:        NewName,
		Config:      configs,     // 这里直接赋值字符串
		NodeOrder:   nodes,       // 这里直接赋值字符串
		ExpireAt:    expireAt,    // 订阅过期时间
		AccessLimit: accessLimit, // 访问次数限制，0 表示不限
		Nodes:       NodesData,   // 这里直接赋值 nodes 数组

	}

	err = OldSub.Update(&NewSub)
	if err != nil {
		c.JSON(400, gin.H{
			"msg": "更新订阅失败: " + err.Error(),
		})
		return
	}
	clearSubscriptionCache()

	c.JSON(200, gin.H{
		"code": "00000",
		"msg":  "更新订阅成功",
	})
}

// 删除订阅 (无需修改)
func SubDel(c *gin.Context) {
	var sub models.Subcription
	id := c.Query("id")
	if id == "" {
		c.JSON(400, gin.H{
			"msg": "id 不能为空",
		})
		return
	}
	x, err := strconv.Atoi(id) // 增加错误检查
	if err != nil {
		c.JSON(400, gin.H{
			"msg": "无效的 ID: " + err.Error(),
		})
		return
	}
	sub.ID = x
	err = sub.Find()
	if err != nil {
		c.JSON(400, gin.H{
			"msg": "查找订阅失败: " + err.Error(),
		})
		return
	}
	err = sub.Del()
	if err != nil {
		c.JSON(400, gin.H{
			"msg": "删除订阅失败: " + err.Error(),
		})
		return
	}
	clearSubscriptionCache()
	c.JSON(200, gin.H{
		"code": "00000",
		"msg":  "删除订阅成功",
	})
}

func SubResetToken(c *gin.Context) {
	id, err := strconv.Atoi(c.PostForm("id"))
	if err != nil || id <= 0 {
		c.JSON(400, gin.H{"msg": "id 不能为空"})
		return
	}
	token := models.GenerateSubscriptionToken()
	if token == "" {
		c.JSON(500, gin.H{"msg": "生成 token 失败"})
		return
	}
	err = models.DB.Model(&models.Subcription{}).Where("id = ?", id).
		Updates(map[string]any{"token": token, "legacy_token_disabled": true, "revoked": false, "access_count": 0}).Error
	if err != nil {
		c.JSON(500, gin.H{"msg": err.Error()})
		return
	}
	clearSubscriptionCache()
	c.JSON(200, gin.H{"code": "00000", "data": gin.H{"token": token}, "msg": "token 已重置"})
}

func SubSetRevoked(c *gin.Context) {
	id, err := strconv.Atoi(c.PostForm("id"))
	if err != nil || id <= 0 {
		c.JSON(400, gin.H{"msg": "id 不能为空"})
		return
	}
	revoked := c.PostForm("revoked") == "true"
	if err := models.DB.Model(&models.Subcription{}).Where("id = ?", id).Update("revoked", revoked).Error; err != nil {
		c.JSON(500, gin.H{"msg": err.Error()})
		return
	}
	clearSubscriptionCache()
	c.JSON(200, gin.H{"code": "00000", "msg": "状态已更新"})
}

func SubPreview(c *gin.Context) {
	id, err := strconv.Atoi(c.Query("id"))
	if err != nil || id <= 0 {
		c.JSON(400, gin.H{"msg": "id 不能为空"})
		return
	}

	var sub models.Subcription
	sub.ID = id
	if err := sub.Find(); err != nil {
		c.JSON(404, gin.H{"msg": "订阅不存在"})
		return
	}

	outputType := subscriptionOutputType(sub)
	format := strings.ToLower(strings.TrimSpace(c.Query("client")))
	if format == "" || format == "v2ray" {
		format = outputType
	}
	format, allowed := subscriptionFormatForType(c, format, outputType)
	if !allowed || format == "v2ray" {
		c.JSON(400, gin.H{"msg": fmt.Sprintf("%s 订阅不支持查看 %s 源配置", outputType, format)})
		return
	}

	originalURL := c.Request.URL
	previewURL := *originalURL
	previewURL.Path = "/c/"
	previewURL.RawPath = ""
	previewURL.RawQuery = url.Values{
		"token":  []string{sub.Token},
		"client": []string{format},
	}.Encode()
	previewURL.Fragment = ""
	c.Request.URL = &previewURL
	defer func() {
		c.Request.URL = originalURL
	}()

	c.Set("subname", sub.Name)
	var resp subscriptionCacheEntry
	switch format {
	case "clash":
		resp, err = buildClashSubscription(c)
	case "surge":
		resp, err = buildSurgeSubscription(c)
	case "egern":
		resp, err = buildEgernSubscription(c)
	default:
		err = fmt.Errorf("不支持的订阅格式: %s", format)
	}
	if err != nil {
		c.JSON(500, gin.H{"msg": err.Error()})
		return
	}

	c.JSON(200, gin.H{
		"code": "00000",
		"data": gin.H{
			"name":         sub.Name,
			"format":       format,
			"filename":     resp.filename,
			"content_type": resp.contentType,
			"node_count":   resp.nodeCount,
			"content":      string(resp.body),
		},
		"msg": "订阅文件生成成功",
	})
}

func parseOptionalInt(value string) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, nil
	}
	return strconv.Atoi(value)
}

func parseExpireAt(value string) (*time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	layouts := []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02"}
	for _, layout := range layouts {
		if parsed, err := time.ParseInLocation(layout, value, time.Local); err == nil {
			return &parsed, nil
		}
	}
	return nil, strconv.ErrSyntax
}

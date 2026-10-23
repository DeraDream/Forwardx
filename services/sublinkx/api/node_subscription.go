package api

import (
	"fmt"
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

func NodeSubGet(c *gin.Context) {
	var sub models.NodeSubscription
	subs, err := sub.List()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "node subscription list error"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": "00000", "data": subs, "msg": "node subscription get"})
}

func NodeSubAdd(c *gin.Context) {
	name := strings.TrimSpace(c.PostForm("name"))
	nodes := c.PostForm("nodes")
	expireAt, err := parseExpireAt(c.PostForm("expire_at"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "过期时间格式不正确"})
		return
	}
	accessLimit, err := parseOptionalInt(c.PostForm("access_limit"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "访问次数限制格式不正确"})
		return
	}
	if name == "" || strings.TrimSpace(nodes) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "节点订阅名称或节点不能为空"})
		return
	}
	nodesData, err := buildNodesFromRefs(nodes)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	sub := models.NodeSubscription{
		Name:        name,
		NodeOrder:   nodes,
		ExpireAt:    expireAt,
		AccessLimit: accessLimit,
		Nodes:       nodesData,
	}
	if err := sub.Add(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "添加节点订阅失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": "00000", "msg": "添加节点订阅成功"})
}

func NodeSubUpdate(c *gin.Context) {
	newName := strings.TrimSpace(c.PostForm("name"))
	oldName := strings.TrimSpace(c.PostForm("oldname"))
	nodes := c.PostForm("nodes")
	expireAt, err := parseExpireAt(c.PostForm("expire_at"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "过期时间格式不正确"})
		return
	}
	accessLimit, err := parseOptionalInt(c.PostForm("access_limit"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "访问次数限制格式不正确"})
		return
	}
	if newName == "" || strings.TrimSpace(nodes) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "节点订阅名称或节点不能为空"})
		return
	}
	nodesData, err := buildNodesFromRefs(nodes)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	oldSub := models.NodeSubscription{Name: oldName}
	newSub := models.NodeSubscription{
		Name:        newName,
		NodeOrder:   nodes,
		ExpireAt:    expireAt,
		AccessLimit: accessLimit,
		Nodes:       nodesData,
	}
	if err := oldSub.Update(&newSub); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "更新节点订阅失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": "00000", "msg": "更新节点订阅成功"})
}

func NodeSubDel(c *gin.Context) {
	id, err := strconv.Atoi(c.Query("id"))
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "id 不能为空"})
		return
	}
	sub := models.NodeSubscription{ID: id}
	if err := sub.Find(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "查找节点订阅失败: " + err.Error()})
		return
	}
	if err := sub.Del(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "删除节点订阅失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": "00000", "msg": "删除节点订阅成功"})
}

func NodeSubResetToken(c *gin.Context) {
	id, err := strconv.Atoi(c.PostForm("id"))
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "id 不能为空"})
		return
	}
	token := models.GenerateSubscriptionToken()
	if token == "" {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "生成 token 失败"})
		return
	}
	if err := models.DB.Model(&models.NodeSubscription{}).Where("id = ?", id).
		Updates(map[string]any{"token": token, "revoked": false, "access_count": 0}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": "00000", "data": gin.H{"token": token}, "msg": "token 已重置"})
}

func NodeSubSetRevoked(c *gin.Context) {
	id, err := strconv.Atoi(c.PostForm("id"))
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "id 不能为空"})
		return
	}
	revoked := c.PostForm("revoked") == "true"
	if err := models.DB.Model(&models.NodeSubscription{}).Where("id = ?", id).Update("revoked", revoked).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": "00000", "msg": "状态已更新"})
}

func GetNodeSubscriptionClient(c *gin.Context) {
	token := strings.ToLower(strings.TrimSpace(c.Query("token")))
	if token == "" {
		c.Writer.WriteHeader(http.StatusBadRequest)
		c.Writer.WriteString("token为空")
		return
	}
	var sub models.NodeSubscription
	if err := models.DB.Preload("Nodes").Where("token = ?", token).First(&sub).Error; err != nil {
		c.Writer.WriteHeader(http.StatusNotFound)
		c.Writer.WriteString("节点订阅不存在或 token 无效")
		return
	}
	sub.EnsureToken()
	sub.Find()
	if available, reason := sub.IsAvailable(time.Now()); !available {
		c.Writer.WriteHeader(http.StatusForbidden)
		c.Writer.WriteString(reason)
		return
	}
	recordNodeSubscriptionAccess(sub.ID)
	var lines []string
	for _, n := range sub.ActiveNodes() {
		lines = append(lines, subscriptionNodeLinks(n)...)
	}
	filename := fmt.Sprintf("%s-nodes.txt", sub.Name)
	encodedFilename := url.QueryEscape(filename)
	c.Writer.Header().Set("Content-Disposition", "inline; filename*=utf-8''"+encodedFilename)
	c.Writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	c.Writer.WriteString(node.Base64Encode(strings.Join(lines, "\n") + "\n"))
}

func recordNodeSubscriptionAccess(id int) {
	go func() {
		if err := models.DB.Model(&models.NodeSubscription{}).
			Where("id = ?", id).
			UpdateColumn("access_count", gorm.Expr("access_count + ?", 1)).Error; err != nil {
			log.Println("更新节点订阅访问次数失败:", err)
		}
	}()
}

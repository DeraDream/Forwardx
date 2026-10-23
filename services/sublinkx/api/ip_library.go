package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"sublink/models"
	"sublink/node"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func IPEntryList(c *gin.Context) {
	var entries []models.IPEntry
	if err := models.DB.Order("alias asc, id asc").Find(&entries).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "读取 IP 库失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": "00000", "data": entries, "msg": "IP 库读取成功"})
}

func IPEntryAdd(c *gin.Context) {
	alias, address, ok := validateIPEntryForm(c)
	if !ok {
		return
	}
	entry := models.IPEntry{Alias: alias, Address: address}
	if err := models.DB.Create(&entry).Error; err != nil {
		if isUniqueConstraintError(err) {
			c.JSON(http.StatusConflict, gin.H{"msg": "该 IP 已存在"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "添加 IP 失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": "00000", "data": entry, "msg": "IP 已添加"})
}

func IPEntryUpdate(c *gin.Context) {
	id, err := strconv.Atoi(c.PostForm("id"))
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "IP 记录 ID 不正确"})
		return
	}
	alias, address, ok := validateIPEntryForm(c)
	if !ok {
		return
	}
	var entry models.IPEntry
	if err := models.DB.First(&entry, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"msg": "IP 记录不存在"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "读取 IP 记录失败"})
		return
	}
	if err := models.DB.Model(&entry).Updates(map[string]any{"alias": alias, "address": address}).Error; err != nil {
		if isUniqueConstraintError(err) {
			c.JSON(http.StatusConflict, gin.H{"msg": "该 IP 已存在"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "更新 IP 失败"})
		return
	}
	entry.Alias = alias
	entry.Address = address
	c.JSON(http.StatusOK, gin.H{"code": "00000", "data": entry, "msg": "IP 已更新"})
}

func IPEntryDelete(c *gin.Context) {
	id, err := strconv.Atoi(c.Query("id"))
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "IP 记录 ID 不正确"})
		return
	}
	result := models.DB.Unscoped().Delete(&models.IPEntry{}, id)
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "删除 IP 失败"})
		return
	}
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"msg": "IP 记录不存在"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": "00000", "msg": "IP 已删除"})
}

func NodeReplacementPreview(c *gin.Context) {
	link := strings.TrimSpace(c.PostForm("link"))
	entry, ok := findReplacementIP(c, c.PostForm("replace_ip_id"))
	if !ok {
		return
	}
	result, err := node.ReplaceServerAddress(link, entry.Address)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"code": "00000",
		"data": gin.H{
			"protocol":      result.Protocol,
			"original_host": result.OriginalHost,
			"port":          result.Port,
			"link":          result.Link,
			"ip_entry":      entry,
		},
		"msg": "替换预览生成成功",
	})
}

func validateIPEntryForm(c *gin.Context) (string, string, bool) {
	alias := strings.TrimSpace(c.PostForm("alias"))
	if alias == "" || len([]rune(alias)) > 80 {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "别名不能为空且不能超过 80 个字符"})
		return "", "", false
	}
	address, err := node.NormalizeIPAddress(c.PostForm("address"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"msg": err.Error()})
		return "", "", false
	}
	return alias, address, true
}

func findReplacementIP(c *gin.Context, value string) (models.IPEntry, bool) {
	id, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"msg": "请选择有效的入口 IP"})
		return models.IPEntry{}, false
	}
	var entry models.IPEntry
	if err := models.DB.First(&entry, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"msg": "选择的入口 IP 不存在"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"msg": "读取入口 IP 失败"})
		}
		return models.IPEntry{}, false
	}
	return entry, true
}

func isUniqueConstraintError(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique constraint") || strings.Contains(message, "is not unique")
}

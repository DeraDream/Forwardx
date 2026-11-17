package api

import (
	"net/http"
	"os"

	"sublink/models"

	"github.com/gin-gonic/gin"
)

// SubscriptionSummary returns lightweight, tab-independent totals for the
// subscription center. It intentionally avoids loading node links and template
// bodies just to render tab badges.
func SubscriptionSummary(c *gin.Context) {
	var subscriptions, nodeSubscriptions, nodes int64
	if err := models.DB.Model(&models.Subcription{}).Count(&subscriptions).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "subscription count error"})
		return
	}
	if err := models.DB.Model(&models.NodeSubscription{}).Count(&nodeSubscriptions).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "node subscription count error"})
		return
	}
	if err := models.DB.Model(&models.Node{}).Count(&nodes).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "node count error"})
		return
	}
	if err := ensureBaseTemplateDir(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": err.Error()})
		return
	}
	entries, err := os.ReadDir(baseTemplateDir)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"msg": "template count error"})
		return
	}
	templates := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			templates++
		}
	}
	c.JSON(http.StatusOK, gin.H{"code": "00000", "data": gin.H{
		"subscriptions":      subscriptions,
		"nodeSubscriptions":  nodeSubscriptions,
		"nodes":              nodes,
		"templates":          templates,
	}, "msg": "subscription summary"})
}

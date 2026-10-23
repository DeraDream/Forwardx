package routers

import (
	"sublink/api"

	"github.com/gin-gonic/gin"
)

// TemplateManager is intentionally isolated from Templates: it owns only
// rule_templates and powers the visual Clash/Mihomo template editor.
func TemplateManager(r *gin.Engine) {
	group := r.Group("/api/v1/template-manager")
	{
		group.GET("/list", api.ListVisualTemplates)
		group.GET("/content", api.GetVisualTemplate)
		group.POST("/create", api.CreateVisualTemplate)
		group.POST("/update", api.UpdateVisualTemplate)
		group.POST("/delete", api.DeleteVisualTemplate)
		group.POST("/fetch", api.FetchVisualTemplateSource)
	}
}

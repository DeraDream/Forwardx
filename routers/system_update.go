package routers

import (
	"sublink/api"

	"github.com/gin-gonic/gin"
)

func SystemUpdate(r *gin.Engine, version string) {
	updater := api.NewSystemUpdater(version)
	group := r.Group("/api/v1/system/update")
	{
		group.GET("/check", updater.Check)
		group.GET("/status", updater.Status)
		group.POST("/start", updater.Start)
	}
}

package routers

import (
	"sublink/api"

	"github.com/gin-gonic/gin"
)

func Backup(r *gin.Engine) {
	group := r.Group("/api/v1/backup")
	{
		group.POST("/export", api.BackupExport)
		group.POST("/import", api.BackupImport)
	}
}

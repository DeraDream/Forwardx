package routers

import (
	"sublink/api"

	"github.com/gin-gonic/gin"
)

func Telegram(r *gin.Engine) {
	group := r.Group("/api/v1/telegram")
	{
		group.GET("/config", api.GetTelegramConfig)
		group.POST("/config", api.UpdateTelegramConfig)
		group.POST("/test", api.TestTelegramBot)
	}
}

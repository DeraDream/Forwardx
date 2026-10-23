package routers

import (
	"sublink/api"

	"github.com/gin-gonic/gin"
)

func NodeSubscription(r *gin.Engine) {
	group := r.Group("/api/v1/node-subscription")
	{
		group.POST("/add", api.NodeSubAdd)
		group.DELETE("/delete", api.NodeSubDel)
		group.GET("/get", api.NodeSubGet)
		group.POST("/update", api.NodeSubUpdate)
		group.POST("/reset-token", api.NodeSubResetToken)
		group.POST("/revoked", api.NodeSubSetRevoked)
	}

	clientGroup := r.Group("/n")
	{
		clientGroup.GET("/", api.GetNodeSubscriptionClient)
	}
}

package routers

import (
	"sublink/api"

	"github.com/gin-gonic/gin"
)

func Nodes(r *gin.Engine) {
	NodesGroup := r.Group("/api/v1/nodes")
	{
		NodesGroup.POST("/add", api.NodeAdd)
		NodesGroup.DELETE("/delete", api.NodeDel)
		NodesGroup.GET("/export", api.NodeExport)
		NodesGroup.GET("/get", api.NodeGet)
		NodesGroup.POST("/import", api.NodeImport)
		NodesGroup.POST("/update", api.NodeUpdadte)
		NodesGroup.POST("/disabled", api.NodeSetDisabled)
		NodesGroup.POST("/replace-preview", api.NodeReplacementPreview)

	}
	// 分组
	Group := NodesGroup.Group("/group")
	{
		Group.GET("/get", api.GroupNodeGet)  // 添加分组
		Group.POST("/set", api.GroupNodeSet) // 绑定创建分组
		// Group.DELETE("/delete", api.GroupNodeDel) // 删除分组
		// Group.POST("/update", api.GroupNodeUpdate) // 更新分组
	}
	IPLibrary := r.Group("/api/v1/ip-library")
	{
		IPLibrary.GET("", api.IPEntryList)
		IPLibrary.POST("/add", api.IPEntryAdd)
		IPLibrary.POST("/update", api.IPEntryUpdate)
		IPLibrary.DELETE("/delete", api.IPEntryDelete)
	}
}

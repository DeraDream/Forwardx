package routers

import (
	"sublink/api"

	"github.com/gin-gonic/gin"
)

// Modules exposes the safe remote module inspector used by ForwardX's
// Egern/Loon visual template editor.
func Modules(r *gin.Engine) {
	group := r.Group("/api/v1/module")
	group.POST("/inspect", api.InspectModule)
}

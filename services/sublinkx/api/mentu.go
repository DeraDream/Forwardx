package api

import (
	"github.com/gin-gonic/gin"
)

type Meta struct {
	Title      string   `json:"title"`
	Icon       string   `json:"icon"`
	Hidden     bool     `json:"hidden"`
	Roles      []string `json:"roles"`
	KeepAlive  bool     `json:"keepAlive,omitempty"`
	AlwaysShow bool     `json:"alwaysShow,omitempty"`
}

type Child struct {
	Path      string `json:"path"`
	Component string `json:"component"`
	Name      string `json:"name"`
	Meta      Meta   `json:"meta"`
}

type Menu struct {
	Path      string  `json:"path"`
	Component string  `json:"component"`
	Redirect  string  `json:"redirect"`
	Name      string  `json:"name"`
	Meta      Meta    `json:"meta"`
	Children  []Child `json:"children"`
}

func GetMenus(c *gin.Context) {
	menus := []Menu{
		{
			Path:      "/system",
			Component: "Layout",
			// Redirect:  "/system/user",
			Name: "system",
			Meta: Meta{
				Title:  "system",
				Icon:   "system",
				Hidden: true,
				Roles:  []string{"ADMIN"},
			},
			Children: []Child{
				{
					Path:      "user/set",
					Component: "system/user/set",
					Name:      "Userset",
					Meta: Meta{
						Title:     "userset",
						Icon:      "role",
						Hidden:    true,
						Roles:     []string{"ADMIN"},
						KeepAlive: true,
					},
				},
			},
		},
		{
			Path:      "/subs",
			Component: "Layout",
			Redirect:  "/subs/index",
			Name:      "subscriptions",
			Meta: Meta{
				Title:  "sublist",
				Icon:   "link",
				Hidden: false,
				Roles:  []string{"ADMIN"},
			},
			Children: []Child{
				{
					Path:      "index",
					Component: "subcription/subs",
					Name:      "Subs",
					Meta: Meta{
						Title:     "sublist",
						Icon:      "link",
						Hidden:    false,
						Roles:     []string{"ADMIN"},
						KeepAlive: true,
					},
				},
			},
		},
		{
			Path:      "/node-subs",
			Component: "Layout",
			Redirect:  "/node-subs/index",
			Name:      "nodeSubscriptions",
			Meta: Meta{
				Title:  "nodesublist",
				Icon:   "tree",
				Hidden: false,
				Roles:  []string{"ADMIN"},
			},
			Children: []Child{
				{
					Path:      "index",
					Component: "subcription/node-subs",
					Name:      "NodeSubs",
					Meta: Meta{
						Title:     "nodesublist",
						Icon:      "tree",
						Hidden:    false,
						Roles:     []string{"ADMIN"},
						KeepAlive: true,
					},
				},
			},
		},
		{
			Path:      "/nodes",
			Component: "Layout",
			Redirect:  "/nodes/index",
			Name:      "nodes",
			Meta: Meta{
				Title:  "nodelist",
				Icon:   "publish",
				Hidden: false,
				Roles:  []string{"ADMIN"},
			},
			Children: []Child{
				{
					Path:      "index",
					Component: "subcription/nodes",
					Name:      "Nodes",
					Meta: Meta{
						Title:     "nodelist",
						Icon:      "publish",
						Hidden:    false,
						Roles:     []string{"ADMIN"},
						KeepAlive: true,
					},
				},
			},
		},
		{
			Path:      "/template-manager",
			Component: "Layout",
			Redirect:  "/template-manager/index",
			Name:      "templateManager",
			Meta: Meta{
				Title:  "templatemanager",
				Icon:   "edit",
				Hidden: false,
				Roles:  []string{"ADMIN"},
			},
			Children: []Child{{
				Path: "index", Component: "template-manager/index", Name: "TemplateManager",
				Meta: Meta{Title: "templatemanager", Icon: "edit", Roles: []string{"ADMIN"}, KeepAlive: true},
			}},
		},
		{
			Path:      "/templates",
			Component: "Layout",
			Redirect:  "/templates/index",
			Name:      "templates",
			Meta: Meta{
				Title:  "templatelist",
				Icon:   "document",
				Hidden: false,
				Roles:  []string{"ADMIN"},
			},
			Children: []Child{
				{
					Path:      "index",
					Component: "subcription/template",
					Name:      "Template",
					Meta: Meta{
						Title:     "templatelist",
						Icon:      "document",
						Hidden:    false,
						Roles:     []string{"ADMIN"},
						KeepAlive: true,
					},
				},
			},
		},
		{
			Path:      "/settings",
			Component: "Layout",
			Redirect:  "/settings/telegram",
			Name:      "settings",
			Meta: Meta{
				Title:  "settingsmenu",
				Icon:   "setting",
				Hidden: false,
				Roles:  []string{"ADMIN"},
			},
			Children: []Child{
				{
					Path:      "telegram",
					Component: "settings/telegram",
					Name:      "TelegramBot",
					Meta: Meta{
						Title:     "settingsmenu",
						Icon:      "setting",
						Hidden:    false,
						Roles:     []string{"ADMIN"},
						KeepAlive: true,
					},
				},
			},
		},
	}
	c.JSON(200, gin.H{
		"code": "00000",
		"data": menus,
		"msg":  "获取成功",
	})
}

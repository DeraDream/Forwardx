package api

import (
	"net/url"
	"strings"
	"sublink/models"
	"sublink/telegram"

	"github.com/gin-gonic/gin"
)

type TelegramConfigRequest struct {
	Enabled       bool   `json:"enabled"`
	Token         string `json:"token"`
	AdminChatIDs  string `json:"admin_chat_ids"`
	Language      string `json:"language"`
	APIBaseURL    string `json:"api_base_url"`
	PublicBaseURL string `json:"public_base_url"`
}

func GetTelegramConfig(c *gin.Context) {
	config := models.ReadConfig().Telegram
	if config.Language == "" {
		config.Language = "zh-CN"
	}
	if config.APIBaseURL == "" {
		config.APIBaseURL = "https://api.telegram.org"
	}
	if config.PublicBaseURL == "" {
		config.PublicBaseURL = "https://sublink.yforward7.com"
	}
	c.JSON(200, gin.H{
		"code": "00000",
		"data": gin.H{
			"enabled":          config.Enabled,
			"token_configured": strings.TrimSpace(config.Token) != "",
			"admin_chat_ids":   config.AdminChatIDs,
			"language":         config.Language,
			"api_base_url":     config.APIBaseURL,
			"public_base_url":  config.PublicBaseURL,
		},
		"msg": "获取成功",
	})
}

func UpdateTelegramConfig(c *gin.Context) {
	var request TelegramConfigRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(400, gin.H{"msg": "配置格式不正确"})
		return
	}
	config, err := normalizeTelegramConfig(request)
	if err != nil {
		c.JSON(400, gin.H{"msg": err.Error()})
		return
	}
	oldConfig := models.ReadConfig().Telegram
	if config.Token == "" {
		config.Token = oldConfig.Token
	}
	if config.Enabled && strings.TrimSpace(config.Token) == "" {
		c.JSON(400, gin.H{"msg": "启用机器人前请填写 Telegram Token"})
		return
	}
	if err := telegram.DefaultManager.Reload(config); err != nil {
		c.JSON(400, gin.H{"msg": "启动机器人失败: " + err.Error()})
		return
	}
	if err := models.SetTelegramConfig(config); err != nil {
		_ = telegram.DefaultManager.Reload(oldConfig)
		c.JSON(500, gin.H{"msg": "保存配置失败: " + err.Error()})
		return
	}
	c.JSON(200, gin.H{"code": "00000", "msg": "保存成功"})
}

func TestTelegramBot(c *gin.Context) {
	var request TelegramConfigRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(400, gin.H{"msg": "配置格式不正确"})
		return
	}
	config, err := normalizeTelegramConfig(request)
	if err != nil {
		c.JSON(400, gin.H{"msg": err.Error()})
		return
	}
	if config.Token == "" {
		config.Token = models.ReadConfig().Telegram.Token
	}
	if err := telegram.DefaultManager.TestMessage(config); err != nil {
		c.JSON(400, gin.H{"msg": "发送失败: " + err.Error()})
		return
	}
	c.JSON(200, gin.H{"code": "00000", "msg": "测试消息已发送"})
}

func normalizeTelegramConfig(request TelegramConfigRequest) (models.TelegramConfig, error) {
	apiBaseURL := strings.TrimSpace(request.APIBaseURL)
	if apiBaseURL == "" {
		apiBaseURL = "https://api.telegram.org"
	}
	parsedURL, err := url.ParseRequestURI(apiBaseURL)
	if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		return models.TelegramConfig{}, &configError{"Telegram API 地址格式不正确"}
	}
	publicBaseURL := strings.TrimSpace(request.PublicBaseURL)
	if publicBaseURL == "" {
		publicBaseURL = "https://sublink.yforward7.com"
	}
	parsedPublicURL, err := url.ParseRequestURI(publicBaseURL)
	if err != nil || (parsedPublicURL.Scheme != "http" && parsedPublicURL.Scheme != "https") {
		return models.TelegramConfig{}, &configError{"主控公网地址格式不正确"}
	}
	return models.TelegramConfig{
		Enabled:       request.Enabled,
		Token:         strings.TrimSpace(request.Token),
		AdminChatIDs:  strings.TrimSpace(request.AdminChatIDs),
		Language:      "zh-CN",
		APIBaseURL:    strings.TrimRight(apiBaseURL, "/"),
		PublicBaseURL: strings.TrimRight(publicBaseURL, "/"),
	}, nil
}

type configError struct {
	message string
}

func (e *configError) Error() string {
	return e.message
}

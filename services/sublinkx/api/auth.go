package api

import (
	"log"
	"sublink/middlewares"
	"sublink/models"
	"time"

	"github.com/dgrijalva/jwt-go"
	"github.com/gin-gonic/gin"
)

// 获取token
func GetToken(username string) (string, error) {
	// 过期时间天
	ExpireDays := models.ReadConfig().ExpireDays
	c := &middlewares.JwtClaims{
		Username: username,
		StandardClaims: jwt.StandardClaims{
			ExpiresAt: time.Now().Add(time.Hour * 24 * time.Duration(ExpireDays)).Unix(), // 设置过期时间
			IssuedAt:  time.Now().Unix(),                                                 // 签发时间
			Subject:   username,                                                          // 用户
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	return token.SignedString(middlewares.Secret)
}

// 用户登录
func UserLogin(c *gin.Context) {
	username := c.PostForm("username")
	password := c.PostForm("password")
	user := &models.User{Username: username, Password: password}
	err := user.Verify()
	if err != nil {
		log.Println("账号或者密码错误")
		c.JSON(400, gin.H{
			"msg": "账号或者密码错误",
		})
		return
	}
	// 生成token
	token, err := GetToken(username)
	if err != nil {
		log.Println("获取token失败", err)
		c.JSON(400, gin.H{
			"msg": "获取token失败",
		})
		return
	}
	// 登录成功返回token
	c.JSON(200, gin.H{
		"code": "00000",
		"data": gin.H{
			"accessToken":  token,
			"tokenType":    "Bearer",
			"refreshToken": nil,
			"expires":      nil,
		},
		"msg": "登录成功",
	})
}
func UserOut(c *gin.Context) {
	// 拿到jwt中的username
	if _, Is := c.Get("username"); Is {
		c.JSON(200, gin.H{
			"code": "00000",
			"msg":  "退出成功",
		})
	}
}

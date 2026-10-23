package middlewares

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"sublink/models"

	"github.com/gin-gonic/gin"
	"golang.org/x/text/encoding/simplifiedchinese"
	"gorm.io/gorm"
)

const ipLogUpdateInterval = 10 * time.Minute

func GetIp(c *gin.Context) {
	c.Next()
	subname, _ := c.Get("subname")
	subnameStr, ok := subname.(string)
	if !ok || subnameStr == "" {
		return
	}
	ip := c.ClientIP()
	go recordSubscriptionIP(subnameStr, ip)
}

func recordSubscriptionIP(subname string, ip string) {
	var sub models.Subcription
	if err := models.DB.Select("id").Where("name = ?", subname).First(&sub).Error; err != nil {
		log.Println("查找订阅失败:", err)
		return
	}

	var iplog models.SubLogs
	iplog.IP = ip
	err := iplog.Find(sub.ID)
	if err == nil {
		if recentIPLog(iplog.Date) {
			return
		}
		iplog.Count++
		iplog.Date = time.Now().Format("2006-01-02 15:04:05")
		if err := iplog.Update(); err != nil {
			log.Println("更新IP日志记录失败:", err)
		}
		return
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		log.Println("查找IP日志失败:", err)
		return
	}

	addr := lookupIPAddr(ip)
	newIplog := models.SubLogs{
		IP:            ip,
		Addr:          addr,
		SubcriptionID: sub.ID,
		Date:          time.Now().Format("2006-01-02 15:04:05"),
		Count:         1,
	}
	if err := newIplog.Add(); err != nil {
		log.Println("添加IP日志记录失败:", err)
	}
}

func recentIPLog(value string) bool {
	last, err := time.ParseInLocation("2006-01-02 15:04:05", value, time.Local)
	if err != nil {
		return false
	}
	return time.Since(last) < ipLogUpdateInterval
}

func lookupIPAddr(ip string) string {
	resp, err := http.Get(fmt.Sprintf("https://whois.pconline.com.cn/ipJson.jsp?ip=%s&json=true", ip))
	if err != nil {
		log.Println("获取IP信息失败:", err)
		return ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	utf8Body, _ := simplifiedchinese.GBK.NewDecoder().Bytes(body)
	type IpInfo struct {
		Addr string `json:"addr"`
		Ip   string `json:"ip"`
	}
	ipinfo := IpInfo{}
	if err := json.Unmarshal(utf8Body, &ipinfo); err != nil {
		log.Println("解析IP信息失败:", err)
		return ""
	}
	return ipinfo.Addr
}

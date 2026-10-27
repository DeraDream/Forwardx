package api

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"sublink/models"
	"sublink/node"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const subscriptionCacheTTL = 60 * time.Second

type subscriptionCacheEntry struct {
	contentType string
	filename    string
	nodeCount   int
	body        []byte
	expiresAt   time.Time
}

var subscriptionCache sync.Map

// md5加密
func Md5(src string) string {
	m := md5.New()
	m.Write([]byte(src))
	res := hex.EncodeToString(m.Sum(nil))
	return res
}
func GetClient(c *gin.Context) {
	start := time.Now()
	// 获取协议头
	token := c.Query("token")
	clientIndex := strings.ToLower(strings.TrimSpace(c.Query("client"))) // 客户端标识
	if token == "" {
		log.Println("token为空")
		c.Writer.WriteString("token为空")
		return
	}
	sub, ok := findSubscriptionByToken(token)
	if !ok {
		c.Writer.WriteHeader(http.StatusNotFound)
		c.Writer.WriteString("订阅不存在或 token 无效")
		return
	}
	if available, reason := sub.IsAvailable(time.Now()); !available {
		c.Writer.WriteHeader(http.StatusForbidden)
		c.Writer.WriteString(reason)
		return
	}
	recordSubscriptionAccess(sub.ID)
	c.Set("subname", sub.Name)
	c.Set("subscription_id", sub.ID)
	c.Set("subscription_start", start)

	outputType := subscriptionOutputType(sub)
	format, allowed := subscriptionFormatForType(c, clientIndex, outputType)
	if !allowed {
		c.Writer.WriteHeader(http.StatusBadRequest)
		c.Writer.WriteString(fmt.Sprintf("%s 订阅不支持 %s 格式", outputType, clientIndex))
		return
	}
	cacheKey, cacheable := subscriptionCacheKey(c, sub, format)
	if cacheable {
		if cached, ok := getSubscriptionCache(cacheKey); ok {
			writeSubscriptionResponse(c, cached)
			logSubscriptionGenerated(c, sub.ID, cached.nodeCount, format)
			return
		}
	}

	var resp subscriptionCacheEntry
	var err error
	switch format {
	case "clash":
		resp, err = buildClashSubscription(c)
	case "surge":
		resp, err = buildSurgeSubscription(c)
	case "egern":
		resp, err = buildEgernSubscription(c)
	case "loon":
		resp, err = buildLoonSubscription(c)
	case "v2ray":
		resp, err = buildV2raySubscription(c)
	default:
		resp, err = buildV2raySubscription(c)
		format = "v2ray"
	}
	if err != nil {
		c.Writer.WriteString(err.Error())
		return
	}
	if cacheable {
		setSubscriptionCache(cacheKey, resp)
	}
	writeSubscriptionResponse(c, resp)
	logSubscriptionGenerated(c, sub.ID, resp.nodeCount, format)
}

func subscriptionStartedAt(c *gin.Context) time.Time {
	if value, ok := c.Get("subscription_start"); ok {
		if startedAt, ok := value.(time.Time); ok {
			return startedAt
		}
	}
	return time.Now()
}

func logSubscriptionGenerated(c *gin.Context, subID int, nodeCount int, format string) {
	log.Printf(
		"subscription generated: id=%d nodes=%d format=%s duration=%s",
		subID,
		nodeCount,
		format,
		time.Since(subscriptionStartedAt(c)),
	)
}

func subscriptionFormat(c *gin.Context, clientIndex string) string {
	switch clientIndex {
	case "clash", "surge", "egern", "loon", "v2ray":
		return clientIndex
	}
	for _, userAgent := range c.Request.Header.Values("User-Agent") {
		ua := strings.ToLower(userAgent)
		if strings.Contains(ua, "clash") {
			return "clash"
		}
		if strings.Contains(ua, "surge") {
			return "surge"
		}
		if strings.Contains(ua, "egern") {
			return "egern"
		}
		if strings.Contains(ua, "loon") {
			return "loon"
		}
	}
	return "v2ray"
}

func subscriptionOutputType(sub models.Subcription) string {
	var config node.SqlConfig
	if json.Unmarshal([]byte(sub.Config), &config) == nil {
		switch strings.ToLower(strings.TrimSpace(config.OutputType)) {
		case "clash", "surge", "egern", "loon":
			return strings.ToLower(strings.TrimSpace(config.OutputType))
		}
	}

	// Older records did not store an output type. Preserve Clash as the
	// default while recognizing clearly named Surge and Egern subscriptions.
	name := strings.ToLower(strings.TrimSpace(sub.Name))
	if strings.Contains(name, "egern") {
		return "egern"
	}
	if strings.Contains(name, "loon") {
		return "loon"
	}
	if strings.Contains(name, "surge") {
		return "surge"
	}
	return "clash"
}

func subscriptionFormatForType(c *gin.Context, requested, outputType string) (string, bool) {
	requested = strings.ToLower(strings.TrimSpace(requested))
	if requested == "" {
		switch outputType {
		case "surge", "egern", "loon":
			return outputType, true
		default:
			format := subscriptionFormat(c, "")
			if format == "clash" {
				return "clash", true
			}
			return "v2ray", true
		}
	}

	switch requested {
	case "clash", "surge", "egern", "loon", "v2ray":
	default:
		return requested, false
	}

	format := requested
	switch outputType {
	case "clash":
		return format, format == "clash" || format == "v2ray"
	case "surge":
		return format, format == "surge"
	case "egern":
		return format, format == "egern"
	case "loon":
		return format, format == "loon"
	default:
		return format, false
	}
}

func subscriptionCacheKey(c *gin.Context, sub models.Subcription, format string) (string, bool) {
	templateHash, cacheable := templateFingerprint(sub.Config, format)
	if !cacheable {
		return "", false
	}
	requestFingerprint := ""
	if format == "egern" {
		requestFingerprint = Md5(egernSubscriptionURL(c))
	}
	return fmt.Sprintf(
		"%d:%s:%s:%s:%s:%s:%s",
		sub.ID,
		format,
		sub.NodeOrder,
		Md5(sub.Config),
		templateHash,
		subscriptionNodesFingerprint(sub.Nodes),
		requestFingerprint,
	), true
}

func egernSubscriptionURL(c *gin.Context) string {
	requestURL := *c.Request.URL
	requestURL.Scheme = strings.ToLower(forwardedHeaderValue(c.GetHeader("X-Forwarded-Proto")))
	if requestURL.Scheme != "http" && requestURL.Scheme != "https" {
		if c.Request.TLS != nil {
			requestURL.Scheme = "https"
		} else {
			requestURL.Scheme = "http"
		}
	}
	requestURL.Host = forwardedHeaderValue(c.GetHeader("X-Forwarded-Host"))
	if requestURL.Host == "" {
		requestURL.Host = c.Request.Host
	}
	query := requestURL.Query()
	query.Set("client", "egern")
	requestURL.RawQuery = query.Encode()
	requestURL.Fragment = ""
	return requestURL.String()
}

func forwardedHeaderValue(value string) string {
	return strings.TrimSpace(strings.SplitN(value, ",", 2)[0])
}

func templateFingerprint(configText string, format string) (string, bool) {
	if format != "clash" && format != "surge" && format != "egern" && format != "loon" {
		return "", true
	}

	var config node.SqlConfig
	if err := json.Unmarshal([]byte(configText), &config); err != nil {
		return "config-error", true
	}
	normalizeSubscriptionTemplateConfig(&config)

	templatePath := config.Clash
	if format == "surge" {
		templatePath = config.Surge
	} else if format == "egern" {
		templatePath = config.Egern
	} else if format == "loon" {
		templatePath = config.Loon
	}
	templatePath = strings.TrimSpace(templatePath)
	if templatePath == "" {
		return "empty-template", true
	}
	if strings.Contains(templatePath, "://") {
		return "", false
	}

	content, err := os.ReadFile(templatePath)
	if err != nil {
		return "missing:" + templatePath, true
	}
	return "local:" + templatePath + ":" + Md5(string(content)), true
}

// normalizeSubscriptionTemplateConfig keeps subscriptions created by older
// ForwardX versions working. Those records can have an empty per-client
// template field, whereas SublinkX expects a concrete local path and would
// otherwise attempt to open an empty filename.
func normalizeSubscriptionTemplateConfig(config *node.SqlConfig) {
	if strings.TrimSpace(config.Clash) == "" {
		config.Clash = "./template/clash.yaml"
	}
	if strings.TrimSpace(config.Egern) == "" {
		config.Egern = "./template/egern.yaml"
	}
	if strings.TrimSpace(config.Loon) == "" {
		config.Loon = "./template/loon.conf"
	}
}

func subscriptionNodesFingerprint(nodes []models.Node) string {
	ordered := append([]models.Node(nil), nodes...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })
	var value strings.Builder
	for _, item := range ordered {
		fmt.Fprintf(
			&value,
			"%d\x00%s\x00%s\x00%t\x00%d\x00",
			item.ID,
			item.Name,
			item.Link,
			item.Disabled,
			item.UpdatedAt.UnixNano(),
		)
	}
	return Md5(value.String())
}

func getSubscriptionCache(key string) (subscriptionCacheEntry, bool) {
	value, ok := subscriptionCache.Load(key)
	if !ok {
		return subscriptionCacheEntry{}, false
	}
	entry, ok := value.(subscriptionCacheEntry)
	if !ok || time.Now().After(entry.expiresAt) {
		subscriptionCache.Delete(key)
		return subscriptionCacheEntry{}, false
	}
	return entry, true
}

func setSubscriptionCache(key string, entry subscriptionCacheEntry) {
	entry.expiresAt = time.Now().Add(subscriptionCacheTTL)
	subscriptionCache.Store(key, entry)
}

func clearSubscriptionCache() {
	subscriptionCache.Range(func(key, _ any) bool {
		subscriptionCache.Delete(key)
		return true
	})
}

func writeSubscriptionResponse(c *gin.Context, resp subscriptionCacheEntry) {
	encodedFilename := url.QueryEscape(resp.filename)
	c.Writer.Header().Set("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0, s-maxage=0")
	c.Writer.Header().Set("CDN-Cache-Control", "no-store")
	c.Writer.Header().Set("Cloudflare-CDN-Cache-Control", "no-store")
	c.Writer.Header().Set("Content-Disposition", "inline; filename*=utf-8''"+encodedFilename)
	c.Writer.Header().Set("Expires", "0")
	c.Writer.Header().Set("Pragma", "no-cache")
	c.Writer.Header().Set("Content-Type", resp.contentType)
	c.Writer.Write(resp.body)
}

func recordSubscriptionAccess(id int) {
	go func() {
		if err := models.DB.Model(&models.Subcription{}).
			Where("id = ?", id).
			UpdateColumn("access_count", gorm.Expr("access_count + ?", 1)).Error; err != nil {
			log.Println("更新订阅访问次数失败:", err)
		}
	}()
}

func subscriptionNameFromContext(c *gin.Context) (string, bool) {
	value, ok := c.Get("subname")
	if !ok {
		return "", false
	}
	name, ok := value.(string)
	name = strings.TrimSpace(name)
	return name, ok && name != ""
}

func findSubscriptionByToken(token string) (models.Subcription, bool) {
	token = strings.ToLower(strings.TrimSpace(token))
	var sub models.Subcription
	if err := models.DB.Preload("Nodes").Preload("SubLogs").Where("token = ?", token).First(&sub).Error; err == nil {
		return sub, true
	}
	var subs []models.Subcription
	if err := models.DB.Preload("Nodes").Preload("SubLogs").Find(&subs).Error; err != nil {
		return models.Subcription{}, false
	}
	for _, item := range subs {
		if item.LegacyTokenDisabled {
			continue
		}
		if models.LegacySubscriptionToken(item.Name) == token {
			if strings.TrimSpace(item.Token) == "" {
				item.EnsureToken()
				_ = models.DB.Model(&item).Update("token", item.Token).Error
			}
			return item, true
		}
	}
	return models.Subcription{}, false
}

func subscriptionNodeLinks(n models.Node) []string {
	link := strings.TrimSpace(n.Link)
	if link == "" {
		return nil
	}
	if strings.Contains(link, "http://") || strings.Contains(link, "https://") {
		return []string{link}
	}
	if !strings.Contains(link, ",") {
		normalized, ok := normalizeSubscriptionNodeLink(linkWithDisplayName(link, n.Name), n.Name)
		if !ok {
			return nil
		}
		return []string{normalized}
	}
	links := strings.Split(link, ",")
	result := make([]string, 0, len(links))
	for _, item := range links {
		item = strings.TrimSpace(item)
		if item != "" {
			normalized, ok := normalizeSubscriptionNodeLink(linkWithDisplayName(item, n.Name), n.Name)
			if ok {
				result = append(result, normalized)
			}
		}
	}
	return result
}

func normalizeSubscriptionNodeLink(link, displayName string) (string, bool) {
	scheme := strings.ToLower(strings.SplitN(link, "://", 2)[0])
	switch scheme {
	case "ss":
		ss, err := node.DecodeSSURL(link)
		if err != nil {
			log.Printf("skip invalid ss node: %v", err)
			return "", false
		}
		if ss.Name == "" {
			ss.Name = strings.TrimSpace(displayName)
		}
		return node.EncodeSSURL(ss), true
	default:
		return link, true
	}
}

func linkWithDisplayName(link, displayName string) string {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		return link
	}
	scheme := strings.ToLower(strings.SplitN(link, "://", 2)[0])
	switch scheme {
	case "vmess":
		vmess, err := node.DecodeVMESSURL(link)
		if err != nil {
			log.Println("重写 vmess 节点名称失败:", err)
			return link
		}
		vmess.Ps = displayName
		if vmess.V == "" {
			vmess.V = "2"
		}
		payload, err := json.Marshal(vmess)
		if err != nil {
			log.Println("重写 vmess 节点名称失败:", err)
			return link
		}
		return "vmess://" + node.Base64Encode(string(payload))
	default:
		u, err := url.Parse(link)
		if err != nil {
			log.Println("重写节点名称失败:", err)
			return link
		}
		u.Fragment = displayName
		return u.String()
	}
}

func GetV2ray(c *gin.Context) {
	resp, err := buildV2raySubscription(c)
	if err != nil {
		c.Writer.WriteString(err.Error())
		return
	}
	writeSubscriptionResponse(c, resp)
}

func buildV2raySubscription(c *gin.Context) (subscriptionCacheEntry, error) {
	var sub models.Subcription
	subName, ok := subscriptionNameFromContext(c)
	if !ok {
		return subscriptionCacheEntry{}, fmt.Errorf("订阅名为空")
	}
	sub.Name = subName
	err := sub.Find()
	if err != nil {
		return subscriptionCacheEntry{}, fmt.Errorf("找不到这个订阅:%s", subName)
	}
	baselist := ""
	activeNodes := sub.ActiveNodes()
	for _, v := range activeNodes {
		nodeLinks := subscriptionNodeLinks(v)
		switch {
		// 如果包含多条节点
		case strings.Contains(v.Link, ","):
			links := nodeLinks
			baselist += strings.Join(links, "\n") + "\n"
			continue
		//如果是订阅转换
		case strings.Contains(v.Link, "http://") || strings.Contains(v.Link, "https://"):
			resp, err := http.Get(v.Link)
			if err != nil {
				log.Println(err)
				return subscriptionCacheEntry{}, err
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			nodes := node.Base64Decode(string(body))
			baselist += nodes + "\n"
		// 默认
		default:
			baselist += strings.Join(nodeLinks, "\n") + "\n"
		}
	}
	return subscriptionCacheEntry{
		contentType: "text/html; charset=utf-8",
		filename:    fmt.Sprintf("%s.txt", subName),
		nodeCount:   len(activeNodes),
		body:        []byte(node.Base64Encode(baselist)),
	}, nil
}
func GetClash(c *gin.Context) {
	resp, err := buildClashSubscription(c)
	if err != nil {
		c.Writer.WriteString(err.Error())
		return
	}
	writeSubscriptionResponse(c, resp)
}

func buildClashSubscription(c *gin.Context) (subscriptionCacheEntry, error) {
	var sub models.Subcription
	subName, ok := subscriptionNameFromContext(c)
	if !ok {
		return subscriptionCacheEntry{}, fmt.Errorf("订阅名为空")
	}
	sub.Name = subName
	err := sub.Find()
	if err != nil {
		return subscriptionCacheEntry{}, fmt.Errorf("找不到这个订阅:%s", subName)
	}
	// err = sub.Find()

	urls := []string{}

	for _, v := range sub.ActiveNodes() {
		nodeLinks := subscriptionNodeLinks(v)
		switch {
		// 如果包含多条节点
		case strings.Contains(v.Link, ","):
			links := nodeLinks
			urls = append(urls, links...)
			continue
		//如果是订阅转换
		case strings.Contains(v.Link, "http://") || strings.Contains(v.Link, "https://"):
			resp, err := http.Get(v.Link)
			if err != nil {
				log.Println(err)
				return subscriptionCacheEntry{}, err
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			nodes := node.Base64Decode(string(body))
			links := strings.Split(nodes, "\n")
			urls = append(urls, links...)
		// 默认
		default:
			urls = append(urls, nodeLinks...)
		}
	}
	var configs node.SqlConfig
	err = json.Unmarshal([]byte(sub.Config), &configs)
	if err != nil {
		return subscriptionCacheEntry{}, fmt.Errorf("配置读取错误")
	}
	normalizeSubscriptionTemplateConfig(&configs)
	DecodeClash, err := node.EncodeClash(urls, configs)
	if err != nil {
		return subscriptionCacheEntry{}, err
	}
	return subscriptionCacheEntry{
		contentType: "text/plain; charset=utf-8",
		filename:    fmt.Sprintf("%s.yaml", subName),
		nodeCount:   len(urls),
		body:        DecodeClash,
	}, nil
}
func GetSurge(c *gin.Context) {
	resp, err := buildSurgeSubscription(c)
	if err != nil {
		c.Writer.WriteString(err.Error())
		return
	}
	writeSubscriptionResponse(c, resp)
}

func GetEgern(c *gin.Context) {
	resp, err := buildEgernSubscription(c)
	if err != nil {
		c.Writer.WriteString(err.Error())
		return
	}
	writeSubscriptionResponse(c, resp)
}

func GetLoon(c *gin.Context) {
	resp, err := buildLoonSubscription(c)
	if err != nil {
		c.Writer.WriteString(err.Error())
		return
	}
	writeSubscriptionResponse(c, resp)
}

func buildLoonSubscription(c *gin.Context) (subscriptionCacheEntry, error) {
	var sub models.Subcription
	subName, ok := subscriptionNameFromContext(c)
	if !ok {
		return subscriptionCacheEntry{}, fmt.Errorf("订阅名为空")
	}
	sub.Name = subName
	if err := sub.Find(); err != nil {
		return subscriptionCacheEntry{}, fmt.Errorf("找不到这个订阅:%s", subName)
	}

	urls := []string{}
	for _, item := range sub.ActiveNodes() {
		nodeLinks := subscriptionNodeLinks(item)
		switch {
		case strings.Contains(item.Link, ","):
			urls = append(urls, nodeLinks...)
		case strings.Contains(item.Link, "http://") || strings.Contains(item.Link, "https://"):
			resp, err := http.Get(item.Link)
			if err != nil {
				return subscriptionCacheEntry{}, err
			}
			body, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if readErr != nil {
				return subscriptionCacheEntry{}, readErr
			}
			urls = append(urls, strings.Split(node.Base64Decode(string(body)), "\n")...)
		default:
			urls = append(urls, nodeLinks...)
		}
	}

	var config node.SqlConfig
	if err := json.Unmarshal([]byte(sub.Config), &config); err != nil {
		return subscriptionCacheEntry{}, fmt.Errorf("配置读取错误")
	}
	normalizeSubscriptionTemplateConfig(&config)
	output, err := node.EncodeLoon(urls, config)
	if err != nil {
		return subscriptionCacheEntry{}, err
	}
	return subscriptionCacheEntry{
		contentType: "text/plain; charset=utf-8",
		filename:    fmt.Sprintf("%s.conf", subName),
		nodeCount:   len(urls),
		body:        []byte(output),
	}, nil
}

func buildEgernSubscription(c *gin.Context) (subscriptionCacheEntry, error) {
	var sub models.Subcription
	subName, ok := subscriptionNameFromContext(c)
	if !ok {
		return subscriptionCacheEntry{}, fmt.Errorf("订阅名为空")
	}
	sub.Name = subName
	if err := sub.Find(); err != nil {
		return subscriptionCacheEntry{}, fmt.Errorf("找不到这个订阅:%s", subName)
	}

	urls := []string{}
	for _, item := range sub.ActiveNodes() {
		nodeLinks := subscriptionNodeLinks(item)
		switch {
		case strings.Contains(item.Link, ","):
			urls = append(urls, nodeLinks...)
		case strings.Contains(item.Link, "http://") || strings.Contains(item.Link, "https://"):
			resp, err := http.Get(item.Link)
			if err != nil {
				log.Println(err)
				return subscriptionCacheEntry{}, err
			}
			body, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if readErr != nil {
				return subscriptionCacheEntry{}, readErr
			}
			nodes := node.Base64Decode(string(body))
			urls = append(urls, strings.Split(nodes, "\n")...)
		default:
			urls = append(urls, nodeLinks...)
		}
	}

	var configs node.SqlConfig
	if err := json.Unmarshal([]byte(sub.Config), &configs); err != nil {
		return subscriptionCacheEntry{}, fmt.Errorf("配置读取错误")
	}
	normalizeSubscriptionTemplateConfig(&configs)
	configs.EgernUpdateURL = egernSubscriptionURL(c)
	output, err := node.EncodeEgern(urls, configs)
	if err != nil {
		return subscriptionCacheEntry{}, err
	}
	return subscriptionCacheEntry{
		contentType: "text/yaml; charset=utf-8",
		filename:    fmt.Sprintf("%s.yaml", subName),
		nodeCount:   len(urls),
		body:        output,
	}, nil
}

func buildSurgeSubscription(c *gin.Context) (subscriptionCacheEntry, error) {
	var sub models.Subcription
	subName, ok := subscriptionNameFromContext(c)
	if !ok {
		return subscriptionCacheEntry{}, fmt.Errorf("订阅名为空")
	}
	sub.Name = subName
	err := sub.Find()
	if err != nil {
		return subscriptionCacheEntry{}, fmt.Errorf("找不到这个订阅:%s", subName)
	}
	urls := []string{}
	for _, v := range sub.ActiveNodes() {
		nodeLinks := subscriptionNodeLinks(v)
		switch {
		// 如果包含多条节点
		case strings.Contains(v.Link, ","):
			links := nodeLinks
			urls = append(urls, links...)
			continue
		//如果是订阅转换
		case strings.Contains(v.Link, "http://") || strings.Contains(v.Link, "https://"):
			resp, err := http.Get(v.Link)
			if err != nil {
				log.Println(err)
				return subscriptionCacheEntry{}, err
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			nodes := node.Base64Decode(string(body))
			links := strings.Split(nodes, "\n")
			urls = append(urls, links...)
		// 默认
		default:
			urls = append(urls, nodeLinks...)
		}
	}

	var configs node.SqlConfig
	err = json.Unmarshal([]byte(sub.Config), &configs)
	if err != nil {
		return subscriptionCacheEntry{}, fmt.Errorf("配置读取错误")
	}
	// log.Println("surge路径:", configs)
	DecodeClash, err := node.EncodeSurge(urls, configs)
	if err != nil {
		return subscriptionCacheEntry{}, err
	}
	host := c.Request.Host
	url := c.Request.URL.String()
	// 如果包含头部更新信息
	if strings.Contains(DecodeClash, "#!MANAGED-CONFIG") {
		return subscriptionCacheEntry{
			contentType: "text/plain; charset=utf-8",
			filename:    fmt.Sprintf("%s.conf", subName),
			nodeCount:   len(urls),
			body:        []byte(DecodeClash),
		}, nil
	}
	// 否则就插入头部更新信息
	interval := fmt.Sprintf("#!MANAGED-CONFIG %s interval=86400 strict=false", host+url)
	return subscriptionCacheEntry{
		contentType: "text/plain; charset=utf-8",
		filename:    fmt.Sprintf("%s.conf", subName),
		nodeCount:   len(urls),
		body:        []byte(interval + "\n" + DecodeClash),
	}, nil
}

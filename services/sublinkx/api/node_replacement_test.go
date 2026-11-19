package api

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"sublink/models"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestNodeAddReplacesServerBeforeSaving(t *testing.T) {
	previousDB := models.DB
	t.Cleanup(func() { models.DB = previousDB })

	database, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "replacement.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	closeTestDatabase(t, database)
	if err := database.AutoMigrate(&models.Node{}, &models.IPEntry{}); err != nil {
		t.Fatal(err)
	}
	models.DB = database
	entry := models.IPEntry{Alias: "香港入口", Address: "198.51.100.24"}
	if err := database.Create(&entry).Error; err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/nodes/add", NodeAdd)
	form := url.Values{
		"name":          {"实时替换测试"},
		"link":          {"ss://YWVzLTI1Ni1nY206cGFzcw==@203.0.113.10:8388#修改后的备注"},
		"replace_ip_id": {"1"},
	}
	request := httptest.NewRequest(http.MethodPost, "/nodes/add", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("NodeAdd status = %d, body = %s", response.Code, response.Body.String())
	}

	var saved models.Node
	if err := database.First(&saved).Error; err != nil {
		t.Fatal(err)
	}
	want := "ss://YWVzLTI1Ni1nY206cGFzcw==@198.51.100.24:8388#修改后的备注"
	if saved.Link != want {
		t.Fatalf("saved link = %q, want %q", saved.Link, want)
	}
}

func TestNodeAddReplacesVMessWithNumericPortAndExtractsName(t *testing.T) {
	previousDB := models.DB
	t.Cleanup(func() { models.DB = previousDB })

	database, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "replacement-vmess.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	closeTestDatabase(t, database)
	if err := database.AutoMigrate(&models.Node{}, &models.IPEntry{}); err != nil {
		t.Fatal(err)
	}
	models.DB = database
	entry := models.IPEntry{Alias: "VMess entry", Address: "2001:db8::18"}
	if err := database.Create(&entry).Error; err != nil {
		t.Fatal(err)
	}

	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"v":"2","ps":"VMess numeric port","add":"origin.example.com","port":8443,"id":"11111111-1111-1111-1111-111111111111","net":"ws","host":"cdn.example.com"}`))
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/nodes/add", NodeAdd)
	form := url.Values{"link": {"vmess://" + payload}, "replace_ip_id": {"1"}}
	request := httptest.NewRequest(http.MethodPost, "/nodes/add", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("NodeAdd status = %d, body = %s", response.Code, response.Body.String())
	}

	var saved models.Node
	if err := database.First(&saved).Error; err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(saved.Link, "vmess://"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(decoded), `"add":"2001:db8::18"`) || !strings.Contains(string(decoded), `"host":"cdn.example.com"`) {
		t.Fatalf("saved VMess payload = %s", decoded)
	}
	if saved.Name != "VMess numeric port" {
		t.Fatalf("saved name = %q", saved.Name)
	}
}

func TestNodeUpdateReplacesServerBeforeSaving(t *testing.T) {
	previousDB := models.DB
	t.Cleanup(func() { models.DB = previousDB })

	database, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "replacement-update.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	closeTestDatabase(t, database)
	if err := database.AutoMigrate(&models.Node{}, &models.GroupNode{}, &models.IPEntry{}); err != nil {
		t.Fatal(err)
	}
	models.DB = database
	entry := models.IPEntry{Alias: "update entry", Address: "198.51.100.25"}
	nodeRecord := models.Node{Name: "original", Link: "ss://YWVzLTI1Ni1nY206cGFzcw==@203.0.113.10:8388#original"}
	if err := database.Create(&entry).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&nodeRecord).Error; err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/nodes/update", NodeUpdadte)
	form := url.Values{
		"id":            {"1"},
		"name":          {"updated"},
		"link":          {"ss://YWVzLTI1Ni1nY206cGFzcw==@203.0.113.10:8388#updated"},
		"replace_ip_id": {"1"},
	}
	request := httptest.NewRequest(http.MethodPost, "/nodes/update", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("NodeUpdadte status = %d, body = %s", response.Code, response.Body.String())
	}

	var saved models.Node
	if err := database.First(&saved, nodeRecord.ID).Error; err != nil {
		t.Fatal(err)
	}
	want := "ss://YWVzLTI1Ni1nY206cGFzcw==@198.51.100.25:8388#updated"
	if saved.Link != want {
		t.Fatalf("saved link = %q, want %q", saved.Link, want)
	}
}

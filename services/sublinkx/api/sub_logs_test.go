package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"sublink/models"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestSubscriptionListLoadsLogsOnlyOnDemand(t *testing.T) {
	previousDB := models.DB
	t.Cleanup(func() { models.DB = previousDB })

	database, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "subscription-logs.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	closeTestDatabase(t, database)
	if err := database.AutoMigrate(&models.Subcription{}, &models.Node{}, &models.SubLogs{}); err != nil {
		t.Fatal(err)
	}
	models.DB = database
	first := models.Subcription{Name: "first", Config: "{}"}
	second := models.Subcription{Name: "second", Config: "{}"}
	for _, sub := range []*models.Subcription{&first, &second} {
		if err := database.Create(sub).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, log := range []models.SubLogs{
		{IP: "192.0.2.1", SubcriptionID: first.ID},
		{IP: "192.0.2.2", SubcriptionID: second.ID},
	} {
		if err := database.Create(&log).Error; err != nil {
			t.Fatal(err)
		}
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/get", SubGet)
	router.GET("/logs", SubLogsGet)

	request := func(path string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		return response
	}
	listResponse := request("/get")
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", listResponse.Code, listResponse.Body.String())
	}
	var list struct {
		Data []struct {
			ID      int              `json:"ID"`
			SubLogs []models.SubLogs `json:"SubLogs"`
		} `json:"data"`
	}
	if err := json.Unmarshal(listResponse.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Data) != 2 || len(list.Data[0].SubLogs) != 0 || len(list.Data[1].SubLogs) != 0 {
		t.Fatalf("list unexpectedly included access logs: %s", listResponse.Body.String())
	}

	logsResponse := request(fmt.Sprintf("/logs?id=%d", first.ID))
	if logsResponse.Code != http.StatusOK {
		t.Fatalf("logs status = %d, body = %s", logsResponse.Code, logsResponse.Body.String())
	}
	var logs struct {
		Data []models.SubLogs `json:"data"`
	}
	if err := json.Unmarshal(logsResponse.Body.Bytes(), &logs); err != nil {
		t.Fatal(err)
	}
	if len(logs.Data) != 1 || logs.Data[0].IP != "192.0.2.1" {
		t.Fatalf("logs not scoped to subscription: %s", logsResponse.Body.String())
	}
	if response := request("/logs?id=invalid"); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid ID status = %d, want 400", response.Code)
	}
	if response := request("/logs?id=9999"); response.Code != http.StatusNotFound {
		t.Fatalf("missing subscription status = %d, want 404", response.Code)
	}
}

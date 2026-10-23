package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"sublink/models"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestNodeAddAndUpdateSubscriptionsByID(t *testing.T) {
	previousDB := models.DB
	t.Cleanup(func() { models.DB = previousDB })

	database, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "node-subscriptions.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	closeTestDatabase(t, database)
	if err := database.AutoMigrate(&models.Node{}, &models.GroupNode{}, &models.Subcription{}); err != nil {
		t.Fatal(err)
	}
	models.DB = database
	firstSub := models.Subcription{Name: "first", Config: "{}"}
	secondSub := models.Subcription{Name: "second", Config: "{}"}
	if err := database.Create(&firstSub).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&secondSub).Error; err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/nodes/add", NodeAdd)
	router.POST("/nodes/update", NodeUpdadte)
	addForm := url.Values{
		"name":             {"original name"},
		"link":             {"ss://YWVzLTI1Ni1nY206cGFzcw==@203.0.113.10:8388#original"},
		"subscription_ids": {strconv.Itoa(firstSub.ID) + "," + strconv.Itoa(secondSub.ID)},
	}
	response := performNodeFormRequest(router, "/nodes/add", addForm)
	if response.Code != http.StatusOK {
		t.Fatalf("NodeAdd status = %d, body = %s", response.Code, response.Body.String())
	}

	var created models.Node
	if err := database.First(&created).Error; err != nil {
		t.Fatal(err)
	}
	assertSubscriptionNodeIDs(t, database, firstSub.ID, []int{created.ID})
	assertSubscriptionNodeIDs(t, database, secondSub.ID, []int{created.ID})

	updateForm := url.Values{
		"id":               {strconv.Itoa(created.ID)},
		"name":             {"renamed node"},
		"link":             {"ss://YWVzLTI1Ni1nY206cGFzcw==@198.51.100.20:8388#renamed"},
		"group":            {"test group"},
		"subscription_ids": {strconv.Itoa(secondSub.ID)},
	}
	response = performNodeFormRequest(router, "/nodes/update", updateForm)
	if response.Code != http.StatusOK {
		t.Fatalf("NodeUpdadte status = %d, body = %s", response.Code, response.Body.String())
	}

	assertSubscriptionNodeIDs(t, database, firstSub.ID, nil)
	assertSubscriptionNodeIDs(t, database, secondSub.ID, []int{created.ID})
	var updated models.Node
	if err := database.First(&updated, created.ID).Error; err != nil {
		t.Fatal(err)
	}
	if updated.Name != "renamed node" {
		t.Fatalf("updated name = %q, want renamed node", updated.Name)
	}
}

func performNodeFormRequest(router *gin.Engine, path string, form url.Values) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func assertSubscriptionNodeIDs(t *testing.T, database *gorm.DB, subscriptionID int, want []int) {
	t.Helper()
	var subscription models.Subcription
	if err := database.Preload("Nodes").First(&subscription, subscriptionID).Error; err != nil {
		t.Fatal(err)
	}
	if len(subscription.Nodes) != len(want) {
		t.Fatalf("subscription %d node count = %d, want %d", subscriptionID, len(subscription.Nodes), len(want))
	}
	for index, node := range subscription.Nodes {
		if node.ID != want[index] {
			t.Fatalf("subscription %d node[%d] = %d, want %d", subscriptionID, index, node.ID, want[index])
		}
	}
	wantOrder := ""
	if len(want) > 0 {
		parts := make([]string, 0, len(want))
		for _, id := range want {
			parts = append(parts, strconv.Itoa(id))
		}
		wantOrder = strings.Join(parts, ",")
	}
	if subscription.NodeOrder != wantOrder {
		t.Fatalf("subscription %d node order = %q, want %q", subscriptionID, subscription.NodeOrder, wantOrder)
	}
}

func closeTestDatabase(t *testing.T, database *gorm.DB) {
	t.Helper()
	sqlDatabase, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDatabase.Close() })
}

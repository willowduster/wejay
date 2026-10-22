package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gorilla/websocket"
)

func testApp(t *testing.T) (*server, http.Handler) {
	t.Helper()
	t.Setenv("REDIS_URL", "")
	t.Setenv("USER_DATA_FILE", filepath.Join(t.TempDir(), "users.json"))
	app, err := newServer()
	if err != nil {
		t.Fatal(err)
	}
	return app, app.routes()
}

func request(t *testing.T, handler http.Handler, method, path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	content, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(content))
	req.RemoteAddr = "127.0.0.1:12345"
	if cookie != nil {
		req.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response
}

type joinedRoom struct {
	Room     roomView `json:"room"`
	MemberID string   `json:"memberId"`
	Token    string   `json:"token"`
}

func hostRoom(t *testing.T, handler http.Handler) (joinedRoom, *http.Cookie) {
	t.Helper()
	response := request(t, handler, "POST", "/api/auth/register", map[string]string{"name": "Host DJ", "email": "host@example.com", "password": "a-strong-password"}, nil)
	if response.Code != 201 {
		t.Fatalf("registration: %d %s", response.Code, response.Body)
	}
	cookie := response.Result().Cookies()[0]
	response = request(t, handler, "POST", "/api/rooms", map[string]string{"name": "After Hours"}, cookie)
	var result joinedRoom
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &result) != nil {
		t.Fatalf("create room: %d %s", response.Code, response.Body)
	}
	return result, cookie
}

func TestAccountsPersistHashedAndAuthenticate(t *testing.T) {
	app, handler := testApp(t)
	_, cookie := hostRoom(t, handler)
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatal("session cookie missing security flags")
	}
	if string(app.users["host@example.com"].Password) == "a-strong-password" {
		t.Fatal("password stored in plaintext")
	}
	response := request(t, handler, "GET", "/api/auth/me", nil, cookie)
	if response.Code != 200 || strings.Contains(response.Body.String(), "password") {
		t.Fatal("public account leaked credentials")
	}
	response = request(t, handler, "POST", "/api/auth/login", map[string]string{"email": "host@example.com", "password": "wrong-password"}, nil)
	if response.Code != 401 {
		t.Fatal("wrong password accepted")
	}
	response = request(t, handler, "POST", "/api/auth/login", map[string]string{"email": "host@example.com", "password": "a-strong-password"}, nil)
	if response.Code != 200 {
		t.Fatalf("login: %s", response.Body)
	}
	reloaded, err := newServer()
	if err != nil || len(reloaded.users) != 1 {
		t.Fatal("account not persisted")
	}
	request(t, handler, "POST", "/api/auth/logout", nil, cookie)
	if request(t, handler, "GET", "/api/auth/me", nil, cookie).Code != 401 {
		t.Fatal("logout did not revoke session")
	}
}

func TestRoomCapacityGuestAccessAndOwnership(t *testing.T) {
	_, handler := testApp(t)
	hosted, _ := hostRoom(t, handler)
	endpoint := "/api/rooms/" + hosted.Room.Code
	response := request(t, handler, "POST", "/api/rooms", map[string]string{"name": "Guest room"}, nil)
	if response.Code != 401 {
		t.Fatal("unauthenticated hosting accepted")
	}
	var guest joinedRoom
	for index := 0; index < 3; index++ {
		response = request(t, handler, "POST", endpoint+"/join", map[string]string{"name": fmt.Sprintf("Guest %d", index)}, nil)
		if response.Code != 200 {
			t.Fatalf("guest join: %d %s", response.Code, response.Body)
		}
		if index == 0 {
			_ = json.Unmarshal(response.Body.Bytes(), &guest)
		}
	}
	if response = request(t, handler, "POST", endpoint+"/join", map[string]string{"name": "Fifth DJ"}, nil); response.Code != 409 {
		t.Fatal("fifth DJ accepted")
	}
	response = request(t, handler, "PATCH", endpoint, map[string]any{"locked": true, "token": guest.Token}, nil)
	if response.Code != 403 {
		t.Fatal("guest could change access")
	}
	response = request(t, handler, "PATCH", endpoint, map[string]any{"locked": true, "token": hosted.Token}, nil)
	if response.Code != 200 {
		t.Fatal("owner cannot lock room")
	}
	response = request(t, handler, "POST", endpoint+"/join", map[string]string{"name": "Returning guest", "token": guest.Token}, nil)
	if response.Code != 200 {
		t.Fatal("existing member cannot rejoin locked room")
	}
	response = request(t, handler, "POST", endpoint+"/join", map[string]string{"name": "New guest"}, nil)
	if response.Code != 403 {
		t.Fatal("new member entered locked room")
	}
}

func TestOriginAndNoAudioUpload(t *testing.T) {
	_, handler := testApp(t)
	req := httptest.NewRequest("POST", "/api/auth/register", strings.NewReader(`{}`))
	req.Header.Set("Origin", "https://evil.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != 403 {
		t.Fatal("foreign origin accepted")
	}
	if request(t, handler, "POST", "/api/audio", map[string]string{"audio": "anything"}, nil).Code != 404 {
		t.Fatal("audio upload endpoint must not exist")
	}
}

func TestWebsocketOnlyOneStereoStreamAndAuthenticatedSignaling(t *testing.T) {
	app, handler := testApp(t)
	hosted, _ := hostRoom(t, handler)
	testServer := httptest.NewServer(handler)
	defer testServer.Close()
	endpoint := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/rooms/" + hosted.Room.Code + "/ws"
	if bad, _, err := websocket.DefaultDialer.Dial(endpoint+"?token=bad", nil); err == nil {
		bad.Close()
		t.Fatal("invalid membership token accepted")
	}
	conn, _, err := websocket.DefaultDialer.Dial(endpoint+"?token="+hosted.Token, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var state map[string]any
	if conn.ReadJSON(&state) != nil || state["type"] != "state" {
		t.Fatal("missing initial state")
	}
	if err := conn.WriteJSON(map[string]any{"type": "input", "slot": 0, "active": true, "label": "USB Interface"}); err != nil {
		t.Fatal(err)
	}
	if conn.ReadJSON(&state) != nil {
		t.Fatal("no updated state")
	}
	app.mu.Lock()
	active := app.rooms[hosted.Room.Code].members[hosted.MemberID].Streams[0].Active
	app.mu.Unlock()
	if !active {
		t.Fatal("live input was not advertised")
	}
	_ = conn.WriteJSON(map[string]any{"type": "input", "slot": 1, "active": true})
	_ = conn.WriteJSON(map[string]string{"type": "chat", "text": "Ready to spin"})
	if conn.ReadJSON(&state) != nil || state["type"] != "chat" || state["text"] != "Ready to spin" {
		t.Fatal("chat not relayed")
	}
}

func TestRedisCachesSessionsRoomsAndRateLimits(t *testing.T) {
	cache := miniredis.RunT(t)
	t.Setenv("REDIS_URL", "redis://"+cache.Addr())
	t.Setenv("USER_DATA_FILE", filepath.Join(t.TempDir(), "users.json"))
	app, err := newServer()
	if err != nil {
		t.Fatal(err)
	}
	defer app.cache.Close()
	hosted, cookie := hostRoom(t, app.routes())
	sessionKey := "wejay:session:" + tokenKey(cookie.Value)
	if !cache.Exists(sessionKey) || cache.TTL(sessionKey) < 6*24*time.Hour {
		t.Fatal("session not cached with expiry")
	}
	if !cache.Exists("wejay:room:" + hosted.Room.Code) {
		t.Fatal("room metadata not cached")
	}
	app.mu.Lock()
	app.sessions = map[string]session{}
	app.mu.Unlock()
	response := request(t, app.routes(), "GET", "/api/auth/me", nil, cookie)
	if response.Code != 200 {
		t.Fatal("session could not be restored from Redis")
	}
	request(t, app.routes(), "POST", "/api/auth/logout", nil, cookie)
	if cache.Exists(sessionKey) {
		t.Fatal("logout did not revoke cached session")
	}
	req := httptest.NewRequest("POST", "/api/auth/login", nil)
	if !app.allowed(req, "cache-test", 1) || app.allowed(req, "cache-test", 1) {
		t.Fatal("Redis rate limit not enforced")
	}
	cache.FastForward(61 * time.Second)
	if !app.allowed(req, "cache-test", 1) {
		t.Fatal("rate limit did not expire")
	}
}

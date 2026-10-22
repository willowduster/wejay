package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type inputState struct {
	Active bool   `json:"active"`
	Label  string `json:"label"`
}
type member struct {
	ID      string        `json:"id"`
	Name    string        `json:"name"`
	Streams [1]inputState `json:"streams"`
	token   string
	joined  time.Time
	seen    time.Time
	client  *client
}
type room struct {
	Code    string
	Name    string
	Owner   string
	Locked  bool
	created time.Time
	members map[string]*member
}
type roomView struct {
	Code    string    `json:"code"`
	Name    string    `json:"name"`
	Owner   string    `json:"owner"`
	Locked  bool      `json:"locked"`
	Members []*member `json:"members"`
}
type client struct {
	conn *websocket.Conn
	send chan any
	done chan struct{}
	once sync.Once
}
type message struct {
	Type   string          `json:"type"`
	To     string          `json:"to,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
	Slot   int             `json:"slot,omitempty"`
	Active bool            `json:"active,omitempty"`
	Label  string          `json:"label,omitempty"`
	Text   string          `json:"text,omitempty"`
}

func roomCode() string {
	alphabet := "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	bytes := make([]byte, 6)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	for index := range bytes {
		bytes[index] = alphabet[int(bytes[index])%len(alphabet)]
	}
	return string(bytes)
}
func (item *room) view() roomView {
	result := roomView{Code: item.Code, Name: item.Name, Owner: item.Owner, Locked: item.Locked, Members: []*member{}}
	for _, value := range item.members {
		copy := *value
		copy.client = nil
		result.Members = append(result.Members, &copy)
	}
	sort.Slice(result.Members, func(left, right int) bool { return result.Members[left].joined.Before(result.Members[right].joined) })
	return result
}
func (app *server) ensureOwnerLocked(item *room) {
	if _, exists := item.members[item.Owner]; exists {
		return
	}
	view := item.view()
	if len(view.Members) > 0 {
		item.Owner = view.Members[0].ID
	}
}
func (app *server) findMember(item *room, token string) *member {
	if item == nil || len(token) != 48 {
		return nil
	}
	for _, value := range item.members {
		if value.token == token {
			return value
		}
	}
	return nil
}
func newMember(name string) *member {
	return &member{ID: randomID(), Name: name, token: randomID(), joined: time.Now(), seen: time.Now()}
}
func (app *server) joinResult(item *room, value *member) map[string]any {
	return map[string]any{"room": item.view(), "memberId": value.ID, "token": value.token}
}

func (app *server) createRoom(w http.ResponseWriter, r *http.Request) {
	account := app.currentUser(r)
	if account == nil {
		problem(w, 401, "Sign in to create a room.")
		return
	}
	if !app.allowed(r, "create", 10) {
		problem(w, 429, "Too many rooms. Try again in a minute.")
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &input) {
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" || len(name) > 96 {
		problem(w, 400, "Room name must be 1–96 bytes.")
		return
	}
	app.mu.Lock()
	defer app.mu.Unlock()
	code := roomCode()
	for app.rooms[code] != nil {
		code = roomCode()
	}
	owner := newMember(account.Name)
	item := &room{Code: code, Name: name, Owner: owner.ID, created: time.Now(), members: map[string]*member{owner.ID: owner}}
	app.rooms[code] = item
	respond(w, 201, app.joinResult(item, owner))
	app.cacheRoomLocked(item)
}

func (app *server) listRooms(w http.ResponseWriter, r *http.Request) {
	app.mu.Lock()
	defer app.mu.Unlock()
	result := []map[string]any{}
	for _, item := range app.rooms {
		if !item.Locked && len(item.members) < 4 {
			result = append(result, map[string]any{"code": item.Code, "name": item.Name, "count": len(item.members)})
		}
	}
	sort.Slice(result, func(left, right int) bool { return result[left]["code"].(string) < result[right]["code"].(string) })
	respond(w, 200, map[string]any{"rooms": result})
}

func (app *server) joinRoom(w http.ResponseWriter, r *http.Request) {
	if !app.allowed(r, "join", 30) {
		problem(w, 429, "Too many join attempts. Try again in a minute.")
		return
	}
	var input struct {
		Name  string `json:"name"`
		Token string `json:"token"`
	}
	if !decode(w, r, &input) {
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" || len(name) > 64 {
		problem(w, 400, "Provide a DJ name of 1–64 bytes.")
		return
	}
	app.mu.Lock()
	defer app.mu.Unlock()
	item := app.rooms[strings.ToUpper(r.PathValue("code"))]
	if item == nil {
		problem(w, 404, "Room not found. Check your invite code.")
		return
	}
	if existing := app.findMember(item, input.Token); existing != nil {
		existing.seen = time.Now()
		respond(w, 200, app.joinResult(item, existing))
		return
	}
	if item.Locked {
		problem(w, 403, "The room owner has closed the booth to new DJs.")
		return
	}
	if len(item.members) >= 4 {
		problem(w, 409, "This booth is full. Four DJs maximum.")
		return
	}
	value := newMember(name)
	item.members[value.ID] = value
	respond(w, 200, app.joinResult(item, value))
	app.broadcastLocked(item)
}

func (app *server) updateRoom(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Locked bool   `json:"locked"`
		Token  string `json:"token"`
	}
	if !decode(w, r, &input) {
		return
	}
	app.mu.Lock()
	defer app.mu.Unlock()
	item := app.rooms[strings.ToUpper(r.PathValue("code"))]
	if item == nil {
		problem(w, 404, "Room not found")
		return
	}
	value := app.findMember(item, input.Token)
	if value == nil || value.ID != item.Owner {
		problem(w, 403, "Only the room owner can change access.")
		return
	}
	item.Locked = input.Locked
	app.broadcastLocked(item)
	respond(w, 200, map[string]any{"room": item.view()})
}

func (peer *client) queue(value any) {
	select {
	case <-peer.done:
		return
	default:
	}
	select {
	case peer.send <- value:
	default:
		peer.close()
	}
}
func (peer *client) close() { peer.once.Do(func() { close(peer.done); _ = peer.conn.Close() }) }
func (peer *client) write() {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	defer peer.close()
	for {
		select {
		case <-peer.done:
			return
		case value := <-peer.send:
			_ = peer.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if peer.conn.WriteJSON(value) != nil {
				return
			}
		case <-ticker.C:
			_ = peer.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if peer.conn.WriteMessage(websocket.PingMessage, nil) != nil {
				return
			}
		}
	}
}

func (app *server) broadcastLocked(item *room) {
	view := item.view()
	for _, value := range item.members {
		if value.client != nil {
			value.client.queue(map[string]any{"type": "state", "room": view, "you": value.ID})
		}
	}
	app.cacheRoomLocked(item)
}

func (app *server) cacheRoomLocked(item *room) {
	if app.cache == nil {
		return
	}
	view := item.view()
	view.Members = nil
	content, _ := json.Marshal(view)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_ = app.cache.Set(ctx, "wejay:room:"+item.Code, content, 5*time.Minute).Err()
}

func (app *server) websocket(w http.ResponseWriter, r *http.Request) {
	if !app.allowed(r, "socket", 40) {
		problem(w, 429, "Too many connection attempts")
		return
	}
	app.mu.Lock()
	item := app.rooms[strings.ToUpper(r.PathValue("code"))]
	value := app.findMember(item, r.URL.Query().Get("token"))
	if item == nil || value == nil {
		app.mu.Unlock()
		problem(w, 403, "Invalid room session. Rejoin the room.")
		return
	}
	app.mu.Unlock()
	upgrader := websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096, CheckOrigin: func(request *http.Request) bool {
		return request.Header.Get("Origin") == "" || request.Header.Get("Origin") == app.publicURL
	}}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	peer := &client{conn: conn, send: make(chan any, 64), done: make(chan struct{})}
	app.mu.Lock()
	if item.members[value.ID] != value {
		app.mu.Unlock()
		peer.close()
		return
	}
	if value.client != nil {
		value.client.close()
	}
	value.client = peer
	value.seen = time.Now()
	app.broadcastLocked(item)
	app.mu.Unlock()
	go peer.write()
	defer func() {
		peer.close()
		app.mu.Lock()
		defer app.mu.Unlock()
		if value.client == peer {
			value.client = nil
			value.seen = time.Now()
			value.Streams = [1]inputState{}
			app.broadcastLocked(item)
		}
	}()
	conn.SetReadLimit(65536)
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	window, count := time.Now(), 0
	for {
		var input message
		if err := conn.ReadJSON(&input); err != nil {
			return
		}
		if time.Since(window) > time.Second {
			window = time.Now()
			count = 0
		}
		count++
		if count > 80 {
			return
		}
		app.mu.Lock()
		if value.client != peer {
			app.mu.Unlock()
			return
		}
		switch input.Type {
		case "signal":
			if target := item.members[input.To]; target != nil && target.client != nil && input.To != value.ID && len(input.Data) < 60000 {
				var data struct {
					Description *struct {
						Type string `json:"type"`
						SDP  string `json:"sdp"`
					} `json:"description,omitempty"`
					Candidate *struct {
						Candidate        string  `json:"candidate"`
						SDPMid           *string `json:"sdpMid"`
						SDPMLineIndex    *int    `json:"sdpMLineIndex"`
						UsernameFragment *string `json:"usernameFragment,omitempty"`
					} `json:"candidate,omitempty"`
				}
				if json.Unmarshal(input.Data, &data) == nil && (data.Candidate != nil || data.Description != nil && (data.Description.Type == "offer" || data.Description.Type == "answer")) {
					target.client.queue(map[string]any{"type": "signal", "from": value.ID, "data": data})
				}
			}
		case "input":
			if input.Slot == 0 && len(input.Label) <= 256 {
				value.Streams[input.Slot] = inputState{Active: input.Active, Label: input.Label}
				app.broadcastLocked(item)
			}
		case "chat":
			text := strings.TrimSpace(input.Text)
			if text != "" && len(text) <= 2000 {
				outgoing := map[string]any{"type": "chat", "from": value.ID, "name": value.Name, "text": text, "at": time.Now().UTC().Format(time.RFC3339)}
				for _, target := range item.members {
					if target.client != nil {
						target.client.queue(outgoing)
					}
				}
			}
		default:
			peer.queue(map[string]string{"type": "error", "error": "Unknown room event"})
		}
		app.mu.Unlock()
	}
}

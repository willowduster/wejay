package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
)

type server struct {
	mu        sync.Mutex
	rooms     map[string]*room
	users     map[string]user
	sessions  map[string]session
	limits    map[string]*rateBucket
	cache     *redis.Client
	publicURL string
	dataFile  string
	secure    bool
}

type rateBucket struct {
	count int
	until time.Time
}
type session struct {
	UserID  string    `json:"userId"`
	Expires time.Time `json:"expires"`
}

func newServer() (*server, error) {
	publicURL := env("PUBLIC_URL", "http://localhost:5173")
	app := &server{rooms: map[string]*room{}, users: map[string]user{}, sessions: map[string]session{}, limits: map[string]*rateBucket{}, publicURL: strings.TrimRight(publicURL, "/"), dataFile: env("USER_DATA_FILE", "data/users.json"), secure: strings.HasPrefix(publicURL, "https://")}
	if content, err := os.ReadFile(app.dataFile); err == nil {
		if err := json.Unmarshal(content, &app.users); err != nil {
			return nil, errors.New("invalid account data file")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if address := os.Getenv("REDIS_URL"); address != "" {
		options, err := redis.ParseURL(address)
		if err != nil {
			return nil, err
		}
		app.cache = redis.NewClient(options)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := app.cache.Ping(ctx).Err(); err != nil {
			return nil, errors.New("configured Redis is unavailable")
		}
	}
	return app, nil
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func randomID() string {
	bytes := make([]byte, 24)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	return hex.EncodeToString(bytes)
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func problem(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]string{"error": message})
}
func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 65536)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil || decoder.Decode(new(any)) != io.EOF {
		problem(w, 400, "Invalid request body")
		return false
	}
	return true
}

func (app *server) allowed(r *http.Request, category string, maximum int) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	key := category + ":" + host
	if app.cache != nil {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		count, err := app.cache.Eval(ctx, `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n`, []string{"wejay:rate:" + key}).Int()
		if err == nil {
			return count <= maximum
		}
	}
	app.mu.Lock()
	defer app.mu.Unlock()
	bucket := app.limits[key]
	if bucket == nil || time.Now().After(bucket.until) {
		bucket = &rateBucket{until: time.Now().Add(time.Minute)}
		app.limits[key] = bucket
	}
	bucket.count++
	return bucket.count <= maximum
}

func (app *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"ok": true, "cache": app.cache != nil, "audioStorage": false})
	})
	mux.HandleFunc("GET /api/config", app.config)
	mux.HandleFunc("POST /api/auth/register", app.register)
	mux.HandleFunc("POST /api/auth/login", app.login)
	mux.HandleFunc("POST /api/auth/logout", app.logout)
	mux.HandleFunc("GET /api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		current := app.currentUser(r)
		if current == nil {
			problem(w, 401, "Not signed in")
			return
		}
		respond(w, 200, map[string]any{"user": current.public()})
	})
	mux.HandleFunc("GET /api/auth/google", app.googleStart)
	mux.HandleFunc("GET /api/auth/google/callback", app.googleCallback)
	mux.HandleFunc("GET /api/rooms", app.listRooms)
	mux.HandleFunc("POST /api/rooms", app.createRoom)
	mux.HandleFunc("POST /api/rooms/{code}/join", app.joinRoom)
	mux.HandleFunc("PATCH /api/rooms/{code}", app.updateRoom)
	mux.HandleFunc("GET /api/rooms/{code}/ws", app.websocket)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { problem(w, 404, "Endpoint not found") })
	mux.Handle("/", http.FileServer(http.Dir(env("STATIC_DIR", "../dist"))))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "microphone=(self), camera=()")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != app.publicURL {
			problem(w, 403, "Origin not allowed")
			return
		}
		if r.Method != http.MethodGet && r.Header.Get("Origin") == "" && r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			problem(w, 403, "Cross-site request denied")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (app *server) config(w http.ResponseWriter, r *http.Request) {
	ice := []map[string]any{{"urls": []string{"stun:stun.l.google.com:19302"}}}
	turn := os.Getenv("TURN_URL") != "" && os.Getenv("TURN_USERNAME") != "" && os.Getenv("TURN_CREDENTIAL") != ""
	if turn {
		ice = append(ice, map[string]any{"urls": strings.Split(os.Getenv("TURN_URL"), ","), "username": os.Getenv("TURN_USERNAME"), "credential": os.Getenv("TURN_CREDENTIAL")})
	}
	respond(w, 200, map[string]any{"googleEnabled": os.Getenv("GOOGLE_CLIENT_ID") != "" && os.Getenv("GOOGLE_CLIENT_SECRET") != "", "iceServers": ice, "turnConfigured": turn, "redisEnabled": app.cache != nil})
}

func (app *server) cleanup() {
	app.mu.Lock()
	defer app.mu.Unlock()
	now := time.Now()
	for key, item := range app.sessions {
		if now.After(item.Expires) {
			delete(app.sessions, key)
		}
	}
	for key, item := range app.limits {
		if now.After(item.until) {
			delete(app.limits, key)
		}
	}
	for code, room := range app.rooms {
		for id, member := range room.members {
			if member.client == nil && now.Sub(member.seen) > 60*time.Second {
				delete(room.members, id)
			}
		}
		app.ensureOwnerLocked(room)
		if len(room.members) == 0 && now.Sub(room.created) > 5*time.Minute {
			delete(app.rooms, code)
		} else {
			app.broadcastLocked(room)
		}
	}
}

func main() {
	app, err := newServer()
	if err != nil {
		log.Fatal(err)
	}
	address := env("LISTEN_ADDR", ":8080")
	if _, err := url.ParseRequestURI(app.publicURL); err != nil {
		log.Fatal("Invalid PUBLIC_URL")
	}
	httpServer := &http.Server{Addr: address, Handler: app.routes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				app.cleanup()
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	log.Printf("WeJay signaling server listening on %s; Redis enabled: %t; audio storage: disabled", address, app.cache != nil)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

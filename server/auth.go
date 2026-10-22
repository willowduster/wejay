package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

type user struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password []byte `json:"password,omitempty"`
	GoogleID string `json:"googleId,omitempty"`
}

func (account user) public() map[string]string {
	return map[string]string{"id": account.ID, "name": account.Name, "email": account.Email}
}
func tokenKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (app *server) persistUsersLocked() error {
	if err := os.MkdirAll(filepath.Dir(app.dataFile), 0700); err != nil {
		return err
	}
	content, err := json.Marshal(app.users)
	if err != nil {
		return err
	}
	if err := os.WriteFile(app.dataFile+".tmp", content, 0600); err != nil {
		return err
	}
	return os.Rename(app.dataFile+".tmp", app.dataFile)
}

func (app *server) newSession(w http.ResponseWriter, account user) {
	token := randomID()
	key := tokenKey(token)
	item := session{UserID: account.ID, Expires: time.Now().Add(7 * 24 * time.Hour)}
	app.mu.Lock()
	app.sessions[key] = item
	app.mu.Unlock()
	if app.cache != nil {
		content, _ := json.Marshal(item)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = app.cache.Set(ctx, "wejay:session:"+key, content, 7*24*time.Hour).Err()
	}
	http.SetCookie(w, &http.Cookie{Name: "wejay_session", Value: token, Path: "/", HttpOnly: true, Secure: app.secure, SameSite: http.SameSiteLaxMode, MaxAge: 7 * 24 * 3600})
}

func (app *server) currentUser(r *http.Request) *user {
	cookie, err := r.Cookie("wejay_session")
	if err != nil || len(cookie.Value) != 48 {
		return nil
	}
	key := tokenKey(cookie.Value)
	app.mu.Lock()
	item, exists := app.sessions[key]
	app.mu.Unlock()
	if !exists && app.cache != nil {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if content, err := app.cache.Get(ctx, "wejay:session:"+key).Bytes(); err == nil {
			exists = json.Unmarshal(content, &item) == nil
		}
	}
	if !exists || time.Now().After(item.Expires) {
		return nil
	}
	app.mu.Lock()
	defer app.mu.Unlock()
	for _, account := range app.users {
		if account.ID == item.UserID {
			return &account
		}
	}
	return nil
}

func (app *server) register(w http.ResponseWriter, r *http.Request) {
	if !app.allowed(r, "auth", 12) {
		problem(w, 429, "Too many attempts. Try again in a minute.")
		return
	}
	var input struct {
		Name     string `json:"name"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decode(w, r, &input) {
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	address, err := mail.ParseAddress(input.Email)
	if err != nil || address.Address != input.Email || len(input.Email) > 254 || len(input.Name) < 1 || len(input.Name) > 64 || len(input.Password) < 10 || len(input.Password) > 72 {
		problem(w, 400, "Provide a DJ name, valid email, and a password of 10–72 bytes.")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		problem(w, 500, "Could not create account")
		return
	}
	account := user{ID: randomID(), Name: input.Name, Email: input.Email, Password: hash}
	app.mu.Lock()
	if _, exists := app.users[input.Email]; exists {
		app.mu.Unlock()
		problem(w, 409, "An account with this email already exists.")
		return
	}
	app.users[input.Email] = account
	if err := app.persistUsersLocked(); err != nil {
		delete(app.users, input.Email)
		app.mu.Unlock()
		problem(w, 500, "Account storage unavailable")
		return
	}
	app.mu.Unlock()
	app.newSession(w, account)
	respond(w, 201, map[string]any{"user": account.public()})
}

func (app *server) login(w http.ResponseWriter, r *http.Request) {
	if !app.allowed(r, "auth", 12) {
		problem(w, 429, "Too many attempts. Try again in a minute.")
		return
	}
	var input struct {
		Name     string `json:"name"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decode(w, r, &input) {
		return
	}
	app.mu.Lock()
	account, exists := app.users[strings.ToLower(strings.TrimSpace(input.Email))]
	app.mu.Unlock()
	hash := account.Password
	if len(hash) == 0 {
		hash = []byte("$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy")
	}
	err := bcrypt.CompareHashAndPassword(hash, []byte(input.Password))
	if !exists || len(account.Password) == 0 || err != nil {
		problem(w, 401, "Email or password is incorrect.")
		return
	}
	app.newSession(w, account)
	respond(w, 200, map[string]any{"user": account.public()})
}

func (app *server) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie("wejay_session"); err == nil {
		key := tokenKey(cookie.Value)
		app.mu.Lock()
		delete(app.sessions, key)
		app.mu.Unlock()
		if app.cache != nil {
			ctx, cancel := context.WithTimeout(r.Context(), time.Second)
			defer cancel()
			_ = app.cache.Del(ctx, "wejay:session:"+key).Err()
		}
	}
	http.SetCookie(w, &http.Cookie{Name: "wejay_session", Value: "", Path: "/", HttpOnly: true, Secure: app.secure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	respond(w, 200, map[string]bool{"ok": true})
}

func (app *server) oauthConfig() *oauth2.Config {
	return &oauth2.Config{ClientID: os.Getenv("GOOGLE_CLIENT_ID"), ClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"), RedirectURL: app.publicURL + "/api/auth/google/callback", Scopes: []string{oidc.ScopeOpenID, "email", "profile"}, Endpoint: google.Endpoint}
}

func (app *server) googleStart(w http.ResponseWriter, r *http.Request) {
	if os.Getenv("GOOGLE_CLIENT_ID") == "" || os.Getenv("GOOGLE_CLIENT_SECRET") == "" {
		problem(w, 503, "Google sign-in is not configured")
		return
	}
	state, nonce, verifier := randomID(), randomID(), oauth2.GenerateVerifier()
	for name, value := range map[string]string{"state": state, "nonce": nonce, "verifier": verifier} {
		http.SetCookie(w, &http.Cookie{Name: "wejay_oauth_" + name, Value: value, Path: "/", HttpOnly: true, Secure: app.secure, SameSite: http.SameSiteLaxMode, MaxAge: 300})
	}
	http.Redirect(w, r, app.oauthConfig().AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oidc.Nonce(nonce)), http.StatusFound)
}

func (app *server) googleCallback(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	failed := func() { http.Redirect(w, r, app.publicURL+"/?error=google", http.StatusFound) }
	readCookie := func(name string) string {
		cookie, err := r.Cookie("wejay_oauth_" + name)
		if err != nil {
			return ""
		}
		return cookie.Value
	}
	state, nonce, verifier := readCookie("state"), readCookie("nonce"), readCookie("verifier")
	for _, name := range []string{"state", "nonce", "verifier"} {
		http.SetCookie(w, &http.Cookie{Name: "wejay_oauth_" + name, Value: "", Path: "/", HttpOnly: true, Secure: app.secure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	}
	if state == "" || nonce == "" || verifier == "" || r.URL.Query().Get("state") != state {
		failed()
		return
	}
	token, err := app.oauthConfig().Exchange(ctx, r.URL.Query().Get("code"), oauth2.VerifierOption(verifier))
	if err != nil {
		failed()
		return
	}
	raw, ok := token.Extra("id_token").(string)
	if !ok {
		failed()
		return
	}
	provider, err := oidc.NewProvider(ctx, "https://accounts.google.com")
	if err != nil {
		failed()
		return
	}
	verified, err := provider.Verifier(&oidc.Config{ClientID: os.Getenv("GOOGLE_CLIENT_ID")}).Verify(ctx, raw)
	if err != nil || verified.Nonce != nonce {
		failed()
		return
	}
	var claims struct {
		Subject  string `json:"sub"`
		Email    string `json:"email"`
		Verified bool   `json:"email_verified"`
		Name     string `json:"name"`
	}
	if verified.Claims(&claims) != nil || !claims.Verified || claims.Email == "" || claims.Subject == "" {
		failed()
		return
	}
	email := strings.ToLower(claims.Email)
	app.mu.Lock()
	account, exists := app.users[email]
	if exists && account.GoogleID != "" && account.GoogleID != claims.Subject {
		app.mu.Unlock()
		failed()
		return
	}
	if !exists {
		account = user{ID: randomID(), Email: email, Name: claims.Name}
	}
	if account.Name == "" {
		account.Name = "DJ"
	}
	old, hadOld := app.users[email]
	account.GoogleID = claims.Subject
	app.users[email] = account
	if err := app.persistUsersLocked(); err != nil {
		if hadOld {
			app.users[email] = old
		} else {
			delete(app.users, email)
		}
		app.mu.Unlock()
		failed()
		return
	}
	app.mu.Unlock()
	app.newSession(w, account)
	http.Redirect(w, r, app.publicURL+"/?auth=success", http.StatusFound)
}

package api

import (
	"bytes"
	"compress/zlib"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
)

const sessionAge = 7 * 24 * 60 * 60

func sessionKey(secret string) []byte {
	sum := sha256.Sum256([]byte("sunyu-erp-session-v1signer" + secret))
	return sum[:]
}
func sessionSign(secret, value string) string {
	mac := hmac.New(sha256.New, sessionKey(secret))
	_, _ = mac.Write([]byte(value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func CreateSession(secret string, now time.Time) string {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"authenticated":true}`))
	var stamp [8]byte
	binary.BigEndian.PutUint64(stamp[:], uint64(now.Unix()))
	b := bytes.TrimLeft(stamp[:], "\x00")
	value := payload + "." + base64.RawURLEncoding.EncodeToString(b)
	return value + "." + sessionSign(secret, value)
}
func ValidSession(secret, token string, now time.Time) bool {
	if len(token) > 4096 {
		return false
	}
	dot := strings.LastIndex(token, ".")
	if dot < 1 {
		return false
	}
	value, signature := token[:dot], token[dot+1:]
	if !hmac.Equal([]byte(signature), []byte(sessionSign(secret, value))) {
		return false
	}
	dot = strings.LastIndex(value, ".")
	if dot < 1 {
		return false
	}
	payload, stamp := value[:dot], value[dot+1:]
	b, err := base64.RawURLEncoding.DecodeString(stamp)
	if err != nil || len(b) > 8 {
		return false
	}
	var padded [8]byte
	copy(padded[8-len(b):], b)
	seconds := binary.BigEndian.Uint64(padded[:])
	if seconds > uint64(now.Unix()) || uint64(now.Unix())-seconds > sessionAge {
		return false
	}
	compressed := strings.HasPrefix(payload, ".")
	payload = strings.TrimPrefix(payload, ".")
	data, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return false
	}
	if compressed {
		reader, e := zlib.NewReader(bytes.NewReader(data))
		if e != nil {
			return false
		}
		data, e = io.ReadAll(io.LimitReader(reader, 4097))
		_ = reader.Close()
		if e != nil || len(data) > 4096 {
			return false
		}
	}
	var parsed Row
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if dec.Decode(&parsed) != nil || len(parsed) != 2 {
		return false
	}
	if dec.Decode(new(any)) != io.EOF {
		return false
	}
	v, ok := Int(parsed["v"])
	authenticated, isBool := parsed["authenticated"].(bool)
	return ok && v == 1 && isBool && authenticated
}
func validPassword(s string) bool {
	if len(s) != 6 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func setSessionCookie(w http.ResponseWriter, value string, maxAge int) {
	cookie := &http.Cookie{Name: "sunyu_session", Value: value, Path: "/", MaxAge: maxAge, HttpOnly: true, SameSite: http.SameSiteLaxMode}
	// Retain the previous release's exact cookie attribute spelling.
	w.Header().Add("Set-Cookie", strings.Replace(cookie.String(), "SameSite=Lax", "SameSite=lax", 1))
}
func HashPassword(password string) (string, error) {
	if !validPassword(password) {
		return "", fmt.Errorf("invalid password")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, 3, 65536, 4, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=3,p=4$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(hash)), nil
}
func VerifyPassword(encoded, password string) (bool, error) {
	if !validPassword(password) {
		return false, fmt.Errorf("invalid password")
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || (parts[1] != "argon2id" && parts[1] != "argon2i") || parts[2] != "v=19" {
		return false, fmt.Errorf("invalid password hash")
	}
	params := map[string]uint64{}
	for _, pair := range strings.Split(parts[3], ",") {
		kv := strings.SplitN(pair, "=", 2)
		if len(kv) != 2 {
			return false, fmt.Errorf("invalid hash parameters")
		}
		if _, duplicate := params[kv[0]]; duplicate || (kv[0] != "m" && kv[0] != "t" && kv[0] != "p") {
			return false, fmt.Errorf("invalid hash parameters")
		}
		v, e := strconv.ParseUint(kv[1], 10, 32)
		if e != nil {
			return false, e
		}
		params[kv[0]] = v
	}
	m, t, p := params["m"], params["t"], params["p"]
	if m < 8 || m > 1024*1024 || t < 1 || t > 20 || p < 1 || p > 32 || m < 8*p {
		return false, fmt.Errorf("unsupported hash parameters")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) < 8 || len(salt) > 128 {
		return false, fmt.Errorf("invalid hash salt")
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(expected) < 16 || len(expected) > 128 {
		return false, fmt.Errorf("invalid hash value")
	}
	var actual []byte
	if parts[1] == "argon2i" {
		actual = argon2.Key([]byte(password), salt, uint32(t), uint32(m), uint8(p), uint32(len(expected)))
	} else {
		actual = argon2.IDKey([]byte(password), salt, uint32(t), uint32(m), uint8(p), uint32(len(expected)))
	}
	return subtle.ConstantTimeCompare(expected, actual) == 1, nil
}

type loginAttempts struct {
	mu       sync.Mutex
	failures map[string][]time.Time
	inflight map[string]int
}

func (l *loginAttempts) start(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	old := l.failures[key]
	fresh := old[:0]
	for _, at := range old {
		if now.Sub(at) < 5*time.Minute {
			fresh = append(fresh, at)
		}
	}
	if len(fresh) == 0 {
		delete(l.failures, key)
	} else {
		l.failures[key] = fresh
	}
	if len(fresh)+l.inflight[key] >= 5 {
		return false
	}
	l.inflight[key]++
	return true
}
func (l *loginAttempts) finish(key string, now time.Time, success, record bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	count := l.inflight[key]
	if count <= 0 {
		panic("cannot finish a login attempt that was not started")
	}
	if count == 1 {
		delete(l.inflight, key)
	} else {
		l.inflight[key] = count - 1
	}
	if success {
		delete(l.failures, key)
	} else if record {
		l.failures[key] = append(l.failures[key], now)
	}
}
func RegisterAuth(s *Server) {
	limiter := &loginAttempts{failures: map[string][]time.Time{}, inflight: map[string]int{}}
	password := func(c *Context) (string, error) {
		body, err := c.Body()
		if err != nil || len(body) != 1 || !validPassword(Str(body["password"])) {
			return "", E(422, "Password must be exactly six ASCII digits", "")
		}
		return Str(body["password"]), nil
	}
	s.Public("GET /api/auth/session", func(c *Context) (any, error) {
		row, err := One(c.DB, "SELECT 1 AS configured FROM auth_secret WHERE singleton_id=1")
		if err != nil {
			return nil, err
		}
		cookie, e := c.R.Cookie("sunyu_session")
		return Row{"authenticated": e == nil && ValidSession(s.Config.SessionSecret, cookie.Value, s.Now()), "password_configured": row != nil}, nil
	})
	s.Public("POST /api/auth/setup", func(c *Context) (any, error) {
		pw, err := password(c)
		if err != nil {
			return nil, err
		}
		hash, err := HashPassword(pw)
		if err != nil {
			return nil, err
		}
		return c.Tx(func(tx *Context) (any, error) {
			row, e := One(tx.DB, "SELECT 1 FROM auth_secret WHERE singleton_id=1")
			if e != nil {
				return nil, e
			}
			if row != nil {
				return nil, E(409, "Password is already configured", "")
			}
			_, e = tx.DB.Exec("INSERT INTO auth_secret(singleton_id,password_hash,updated_at) VALUES(1,?,?)", hash, tx.Timestamp())
			tx.Status = 204
			return nil, e
		})
	})
	s.Public("POST /api/auth/login", func(c *Context) (any, error) {
		pw, err := password(c)
		if err != nil {
			return nil, err
		}
		row, err := One(c.DB, "SELECT password_hash FROM auth_secret WHERE singleton_id=1")
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, E(409, "Password is not configured", "")
		}
		host, _, _ := net.SplitHostPort(c.R.RemoteAddr)
		if !limiter.start(host, s.Now()) {
			return nil, E(429, "Too many login attempts", "")
		}
		ok, err := VerifyPassword(Str(row["password_hash"]), pw)
		limiter.finish(host, s.Now(), ok, err == nil)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, E(401, "Invalid password", "")
		}
		setSessionCookie(c.W, CreateSession(s.Config.SessionSecret, s.Now()), sessionAge)
		c.Status = 204
		return nil, nil
	})
	s.Public("POST /api/auth/logout", func(c *Context) (any, error) {
		setSessionCookie(c.W, "", -1)
		c.Status = 204
		return nil, nil
	})
}

package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStrictIntegerAndCanonicalJSON(t *testing.T) {
	for _, v := range []any{true, 1.1, json.Number("9223372036854775808"), "1"} {
		if _, ok := Int(v); ok {
			t.Fatalf("accepted %v", v)
		}
	}
	encoded, err := CanonicalJSON(Row{"z": true, "a": "中文<>", "n": nil, "x": []any{json.Number("2"), "a"}})
	if err != nil || string(encoded) != `{"a": "中文<>", "n": null, "x": [2, "a"], "z": true}` {
		t.Fatalf("%s %v", encoded, err)
	}
}

func TestLegacyJSONLineSeparatorsAndLiteralEscapes(t *testing.T) {
	body := Row{"notes": "a\u2028b\u2029c\\u2028"}
	encoded, err := CanonicalJSON(body)
	if err != nil || string(encoded) != "{\"notes\": \"a\u2028b\u2029c\\\\u2028\"}" {
		t.Fatalf("%s %v", encoded, err)
	}
	got, err := RequestHash(body)
	digest := sha256.Sum256([]byte("{\"notes\":\"a\u2028b\u2029c\\\\u2028\"}"))
	if err != nil || got != hex.EncodeToString(digest[:]) {
		t.Fatal(got, err)
	}
}
func TestBodyRejectsOversizedWhitespaceBeforeSecondObject(t *testing.T) {
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{}`+strings.Repeat(" ", 1<<20)+`{}`))
	c := &Context{R: r}
	if _, err := c.Body(); err == nil {
		t.Fatal("accepted truncated body")
	}
}

func TestJSONUnicodeValidation(t *testing.T) {
	for _, value := range []string{`{"x":"\ud800"}`, `{"x":"\udc00"}`, `{"x":"\ud800\u0041"}`, string([]byte{'"', 0xff, '"'})} {
		if validJSONUnicode([]byte(value)) {
			t.Fatalf("accepted invalid Unicode %q", value)
		}
	}
	for _, value := range []string{`{"x":"\ud83d\ude00"}`, `{"x":"😀"}`, `{"x":"\\ud800"}`, `{"x":"\\\"中文"}`} {
		if !validJSONUnicode([]byte(value)) {
			t.Fatalf("rejected valid Unicode %q", value)
		}
	}
}

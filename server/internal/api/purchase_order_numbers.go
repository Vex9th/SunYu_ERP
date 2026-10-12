package api

import (
	"fmt"
	"github.com/mozillazg/go-pinyin"
	"golang.org/x/text/unicode/norm"
	"strings"
)

func pNamePart(name, fallback string) string {
	args := pinyin.NewArgs()
	args.Style = pinyin.FirstLetter
	args.Fallback = func(r rune, a pinyin.Args) []string { return []string{string(r)} }
	initials := strings.Join(pinyin.LazyPinyin(norm.NFKC.String(name), args), "")
	var b strings.Builder
	for _, r := range strings.ToUpper(initials) {
		if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
		if b.Len() == 24 {
			break
		}
	}
	if b.Len() == 0 {
		return fallback
	}
	return b.String()
}
func pIncrementDecimal(v string) string {
	a := []byte(v)
	for i := len(a) - 1; i >= 0; i-- {
		if a[i] < '9' {
			a[i]++
			return string(a)
		}
		a[i] = '0'
	}
	return "1" + string(a)
}
func pNextOrderNumber(db DBTX, project, supplier Row, date string) string {
	prefix := fmt.Sprintf("PO_%s_%s_%s_", pNamePart(Str(project["name"]), fmt.Sprintf("P%d", pInt(project["id"]))), strings.ReplaceAll(date, "-", ""), pNamePart(Str(supplier["name"]), fmt.Sprintf("S%d", pInt(supplier["id"]))))
	sequence := "0"
	for _, r := range pRows(db, "SELECT order_no FROM purchase_orders WHERE substr(order_no,1,?) = ? COLLATE NOCASE", len(prefix), prefix) {
		no := Str(r["order_no"])
		if len(no) < len(prefix) {
			continue
		}
		suffix := no[len(prefix):]
		valid := suffix != ""
		for _, b := range suffix {
			if b < '0' || b > '9' {
				valid = false
			}
		}
		if !valid {
			continue
		}
		suffix = strings.TrimLeft(suffix, "0")
		if suffix == "" {
			suffix = "0"
		}
		if len(suffix) > len(sequence) || len(suffix) == len(sequence) && suffix > sequence {
			sequence = suffix
		}
	}
	sequence = pIncrementDecimal(sequence)
	if len(sequence) < 3 {
		sequence = strings.Repeat("0", 3-len(sequence)) + sequence
	}
	return prefix + sequence
}

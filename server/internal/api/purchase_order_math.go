package api

import (
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

var procQuantityPattern = regexp.MustCompile(`^-?(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,3})?$`)

func procParseQuantity(value any, negative bool) (int64, error) {
	s, ok := value.(string)
	if !ok || !procQuantityPattern.MatchString(s) {
		return 0, errors.New("Invalid quantity")
	}
	sign := int64(1)
	if strings.HasPrefix(s, "-") {
		sign = -1
		s = s[1:]
	}
	parts := strings.SplitN(s, ".", 2)
	whole, _ := strconv.ParseInt(parts[0], 10, 64)
	frac := int64(0)
	if len(parts) == 2 {
		frac, _ = strconv.ParseInt(parts[1]+strings.Repeat("0", 3-len(parts[1])), 10, 64)
	}
	q := sign * (whole*1000 + frac)
	if q == 0 || q < 0 && !negative {
		return 0, errors.New("Invalid quantity")
	}
	return q, nil
}
func procFormatQuantity(v int64) string {
	sign := ""
	if v < 0 {
		sign = "-"
		v = -v
	}
	return fmt.Sprintf("%s%d.%03d", sign, v/1000, v%1000)
}
func procRoundedProduct(a, b, d int64) (int64, error) {
	if d <= 0 {
		return 0, errors.New("cost allocation denominator must be positive")
	}
	n := new(big.Int).Mul(big.NewInt(a), big.NewInt(b))
	n.Mul(n, big.NewInt(2))
	n.Add(n, big.NewInt(d))
	n.Div(n, new(big.Int).Mul(big.NewInt(d), big.NewInt(2)))
	if !n.IsInt64() {
		return 0, errors.New("Invalid monetary value")
	}
	return n.Int64(), nil
}
func procAmounts(unit, quantity, rate int64) (net, tax, gross int64, err error) {
	if unit < 0 || quantity < 0 || rate < 0 || rate > 10000 {
		err = errors.New("Invalid purchase order payload")
		return
	}
	net, err = procRoundedProduct(unit, quantity, 1000)
	if err != nil {
		return
	}
	tax, err = procRoundedProduct(net, rate, 10000)
	if err != nil {
		return
	}
	sum := new(big.Int).Add(big.NewInt(net), big.NewInt(tax))
	if !sum.IsInt64() {
		err = errors.New("Invalid purchase order payload")
		return
	}
	gross = sum.Int64()
	return
}
func procReceiptCost(gross, ordered, received, receivedValue, quantity int64) (int64, error) {
	remaining := gross - receivedValue
	if remaining < 0 {
		return 0, errors.New("purchase order receipt value exceeds order amount")
	}
	if quantity == ordered-received {
		return remaining, nil
	}
	v, e := procRoundedProduct(gross, quantity, ordered)
	if v > remaining {
		v = remaining
	}
	return v, e
}

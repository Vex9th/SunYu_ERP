package update

import "strings"

func numeric(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
func validVersion(s string) bool {
	if len(s) > 100 || !versionPattern.MatchString(s) {
		return false
	}
	base := strings.SplitN(s, "+", 2)[0]
	parts := strings.SplitN(base, "-", 2)
	if len(parts) == 2 {
		for _, id := range strings.Split(parts[1], ".") {
			if numeric(id) && len(id) > 1 && id[0] == '0' {
				return false
			}
		}
	}
	return true
}
func compareNatural(a, b string) int {
	a = strings.TrimLeft(a, "0")
	b = strings.TrimLeft(b, "0")
	if len(a) < len(b) {
		return -1
	}
	if len(a) > len(b) {
		return 1
	}
	return strings.Compare(a, b)
}
func compareVersion(a, b string) int {
	parse := func(s string) ([]string, []string) {
		s = strings.SplitN(s, "+", 2)[0]
		parts := strings.SplitN(s, "-", 2)
		nums := strings.Split(parts[0], ".")
		for len(nums) < 3 {
			nums = append(nums, "0")
		}
		var pre []string
		if len(parts) > 1 {
			pre = strings.Split(parts[1], ".")
		}
		return nums, pre
	}
	an, ap := parse(a)
	bn, bp := parse(b)
	for i := 0; i < 3; i++ {
		if c := compareNatural(an[i], bn[i]); c != 0 {
			return c
		}
	}
	if len(ap) == 0 && len(bp) > 0 {
		return 1
	}
	if len(bp) == 0 && len(ap) > 0 {
		return -1
	}
	for i := 0; i < len(ap) && i < len(bp); i++ {
		aNum, bNum := numeric(ap[i]), numeric(bp[i])
		if aNum && bNum {
			if c := compareNatural(ap[i], bp[i]); c != 0 {
				return c
			}
		} else if aNum != bNum {
			if aNum {
				return -1
			}
			return 1
		} else if c := strings.Compare(ap[i], bp[i]); c != 0 {
			return c
		}
	}
	if len(ap) < len(bp) {
		return -1
	}
	if len(ap) > len(bp) {
		return 1
	}
	return 0
}

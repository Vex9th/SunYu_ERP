//go:build !updatertest

package main

import "flag"

func addTestFlags(*flag.FlagSet)        {}
func configureTestSource(*Engine) error { return nil }
func testArguments() []string           { return nil }

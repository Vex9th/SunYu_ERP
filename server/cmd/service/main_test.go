package main

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestShutdownWaitsForInFlightRequestBeforeReleasingService(t *testing.T) {
	entered := make(chan struct{})
	finish := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-finish; w.Write([]byte("committed")) })}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stopped := make(chan error, 1)
	go func() { stopped <- serveAndDrain(server, listener, ctx, t.TempDir()) }()
	clientDone := make(chan error, 1)
	go func() {
		r, e := http.Get("http://" + listener.Addr().String())
		if e == nil {
			r.Body.Close()
		}
		clientDone <- e
	}()
	<-entered
	cancel()
	select {
	case e := <-stopped:
		close(finish)
		t.Fatal("service returned before active request completed", e)
	case <-time.After(100 * time.Millisecond):
	}
	close(finish)
	select {
	case e := <-stopped:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("service did not finish")
	}
	if e := <-clientDone; e != nil {
		t.Fatal(e)
	}
}

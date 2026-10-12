package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
	_ "time/tzdata"

	"sunyu.local/erp/internal/api"
	"sunyu.local/erp/internal/config"
	"sunyu.local/erp/internal/database"
	"sunyu.local/erp/internal/lifecycle"
	"sunyu.local/erp/internal/update"
)

var version = "2.0.0-dev"

func run() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	defaultRoot := filepath.Dir(filepath.Dir(executable))
	rootFlag := flag.String("root", defaultRoot, "installation root")
	listen := flag.String("listen", "", "temporary listen address for verification")
	printVersion := flag.Bool("version", false, "print version")
	flag.Parse()
	if *printVersion {
		fmt.Println(version)
		return nil
	}
	root, err := filepath.Abs(*rootFlag)
	if err != nil {
		return err
	}
	release, err := lifecycle.Acquire(root, "server.lock")
	if err != nil {
		return err
	}
	defer release()
	releaseBackend, err := lifecycle.Acquire(root, "backend.lock")
	if err != nil {
		return err
	}
	defer releaseBackend()
	manifestPresent := false
	if _, manifestErr := os.Stat(filepath.Join(root, "app", "manifest.json")); manifestErr == nil {
		manifestPresent = true
		if err = update.ValidateServiceStart(root, os.Getenv("SUNYU_UPDATE_START")); err != nil {
			return err
		}
		manifest, manifestErr := update.ReadManifest(root)
		if manifestErr != nil {
			return manifestErr
		}
		if manifest.BackendVersion != version {
			return errors.New("服务版本与安装清单不一致，已阻止打开业务数据库")
		}
	} else if !os.IsNotExist(manifestErr) {
		return manifestErr
	} else if *listen == "" {
		return errors.New("安装清单缺失，请通过完整目录中的 SunYu_ERP.exe 启动；开发环境请显式指定 --listen")
	}
	settings, err := config.Load(filepath.Join(root, "config.json"))
	if err != nil {
		return err
	}
	if err = os.MkdirAll(settings.DataDir, 0700); err != nil {
		return err
	}
	db, err := database.Open(filepath.Join(settings.DataDir, "iapm.sqlite"))
	if err != nil {
		return err
	}
	defer db.Close()
	if err = database.ApplyMigrations(db); err != nil {
		return err
	}
	app := api.Application(db, settings, root, version)
	if manifestPresent {
		controller, controllerErr := update.NewController(root)
		if controllerErr != nil {
			return controllerErr
		}
		defer controller.Close()
		app.Updates = controller
		app.Supervised = os.Getenv("SUNYU_SUPERVISED") == "1"
	}
	if err = app.System.Start(); err != nil {
		return err
	}
	defer app.System.Close()
	address := *listen
	if address == "" {
		address = net.JoinHostPort(settings.Host, strconv.Itoa(settings.Port))
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, e := os.Stat(filepath.Join(root, ".updates", "maintenance")); e == nil && stringsHasAPIPrefix(r.URL.Path) && !(r.Method == "GET" && (r.URL.Path == "/api/health" || r.URL.Path == "/api/system/updates")) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Retry-After", "3")
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"detail":"系统正在更新，请稍后重试。"}`))
			return
		}
		app.ServeHTTP(w, r)
	})
	server := &http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	log.Printf("SunYu ERP %s listening on %s", version, listener.Addr())
	return serveAndDrain(server, listener, ctx, root)
}
func serveAndDrain(server *http.Server, listener net.Listener, parent context.Context, root string) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = server.Shutdown(context.Background())
				return
			case <-ticker.C:
				for _, name := range []string{"stop", "shutdown"} {
					if _, e := os.Stat(filepath.Join(root, ".updates", name)); e == nil {
						_ = server.Shutdown(context.Background())
						return
					}
				}
			}
		}
	}()
	err := server.Serve(listener)
	// Serve returns when listeners close, before Shutdown has drained handlers.
	// Keep the database and process locks until every active request has exited.
	cancel()
	<-shutdownDone
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
func stringsHasAPIPrefix(path string) bool { return len(path) >= 5 && path[:5] == "/api/" }
func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

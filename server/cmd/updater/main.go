// update.exe owns downloads, installation and recovery independently of the service.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sunyu.local/erp/internal/update"
)

var version = "2.0.0-dev"

func main() {
	err := run()
	if err != nil {
		fmt.Fprintln(os.Stderr, "升级失败：", err)
	}
	noPause := flag.Lookup("no-pause")
	printVersion := flag.Lookup("version")
	if noPause != nil && printVersion != nil && noPause.Value.String() != "true" && printVersion.Value.String() != "true" && !errors.Is(err, update.ErrBusy) && (flag.Lookup("worker").Value.String() == "true" || flag.Lookup("recover").Value.String() == "true" || err != nil) {
		pauseStandaloneConsole()
	}
	if err != nil {
		os.Exit(1)
	}
}
func run() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	root := flag.String("root", filepath.Dir(exe), "原程序安装目录（包含 config.json 和 DATA）")
	archive := flag.String("package", "", "已下载的官方完整更新包（可选）")
	printVersion := flag.Bool("version", false, "显示版本")
	noPause := flag.Bool("no-pause", false, "完成后直接退出（用于命令行自动验证）")
	worker := flag.Bool("worker", false, "内部更新工作进程")
	recover := flag.Bool("recover", false, "内部恢复工作进程")
	job := flag.String("job", "", "内部更新任务")
	flag.Parse()
	if *printVersion {
		fmt.Println(version)
		return nil
	}
	if *worker || *recover {
		return update.RunWorker(*root, *job, *recover)
	}
	e, err := update.NewController(*root)
	if err != nil {
		return err
	}
	defer e.Close()
	e.Visible = !*noPause
	if id, pending := update.Pending(e.Root); pending {
		return e.Recover(id)
	}
	b := make([]byte, 16)
	if _, err = rand.Read(b); err != nil {
		return err
	}
	h := hex.EncodeToString(b)
	id := h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
	fmt.Println("SunYu ERP 原生升级工具：保留原 DATA、配置和业务数据。")
	if *archive == "" {
		err = e.Install(id)
	} else {
		p, cleanup, stageErr := stageArchive(e.Root, *archive, id)
		if stageErr != nil {
			return stageErr
		}
		defer cleanup()
		err = e.Import(p, id)
	}
	if err != nil {
		return err
	}
	if err = e.WaitHandoff(id); err != nil {
		return err
	}
	fmt.Println("独立更新进程已启动，可在网页设置中查看进度。")
	return nil
}

// Bind temporary uploads to opened directories so cleanup cannot follow a replaced path.
func stageArchive(root, archive, id string) (string, func(), error) {
	source, err := os.Open(archive)
	if err != nil {
		return "", nil, err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return "", nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > update.MaxArchiveBytes {
		return "", nil, errors.New("更新包类型或大小无效")
	}
	bound, err := os.OpenRoot(root)
	if err != nil {
		return "", nil, err
	}
	for _, part := range []string{".updates", "imports"} {
		if err = bound.Mkdir(part, 0700); err != nil && !os.IsExist(err) {
			bound.Close()
			return "", nil, err
		}
		before, err := bound.Lstat(part)
		if err != nil {
			bound.Close()
			return "", nil, err
		}
		if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
			bound.Close()
			return "", nil, errors.New("更新暂存目录不能是链接")
		}
		next, err := bound.OpenRoot(part)
		bound.Close()
		if err != nil {
			return "", nil, err
		}
		after, err := next.Stat(".")
		if err != nil || !os.SameFile(before, after) {
			next.Close()
			return "", nil, errors.New("更新暂存目录在打开时发生变化")
		}
		bound = next
	}
	name := id + ".zip"
	dest, err := bound.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		bound.Close()
		return "", nil, err
	}
	created, err := dest.Stat()
	if err != nil {
		dest.Close()
		bound.Close()
		return "", nil, err
	}
	cleanup := func() {
		if current, err := bound.Lstat(name); err == nil && os.SameFile(current, created) {
			_ = bound.Remove(name)
		}
		_ = bound.Close()
	}
	n, copyErr := io.Copy(dest, io.LimitReader(source, update.MaxArchiveBytes+1))
	if copyErr == nil && n > update.MaxArchiveBytes {
		copyErr = errors.New("更新包超过大小限制")
	}
	if copyErr == nil {
		copyErr = dest.Sync()
	}
	closeErr := dest.Close()
	if copyErr != nil {
		cleanup()
		return "", nil, copyErr
	}
	if closeErr != nil {
		cleanup()
		return "", nil, closeErr
	}
	return filepath.Join(root, ".updates", "imports", name), cleanup, nil
}

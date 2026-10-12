// SunYu ERP 的固定启动器；业务代码、版本选择和更新均由外置 supervisor 管理。
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
)

func launch(executable string, stdin io.Reader, stdout, stderr io.Writer) int {
	root := filepath.Dir(executable)
	runtime := filepath.Join(root, "runtime", "SunYuRuntime.exe")
	command := exec.Command(runtime, "--root", root, "--supervise")
	command.Dir = root
	command.Stdin = stdin
	command.Stdout = stdout
	command.Stderr = stderr
	// Windows 将 Ctrl+C 发送给共享控制台中的全部进程；启动器等待 supervisor 清理后退出。
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	defer signal.Stop(interrupts)
	if err := command.Run(); err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && exitError.ExitCode() >= 0 {
			return exitError.ExitCode()
		}
		fmt.Fprintf(stderr, "SunYu ERP 启动失败，请检查完整安装目录 %s：%v\n", runtime, err)
		return 1
	}
	return 0
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "SunYu ERP 无法确定安装目录：%v\n", err)
		os.Exit(1)
	}
	os.Exit(launch(executable, os.Stdin, os.Stdout, os.Stderr))
}

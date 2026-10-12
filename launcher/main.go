// SunYu ERP 的固定启动器；业务代码、版本选择和更新均由外置 supervisor 管理。
package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

func runtimeCommand(executable string, stdin io.Reader, stdout, stderr io.Writer) *exec.Cmd {
	root := filepath.Dir(executable)
	command := exec.Command(filepath.Join(root, "runtime", "SunYuRuntime.exe"), "--root", root, "--supervise")
	command.Dir = root
	command.Stdin, command.Stdout, command.Stderr = stdin, stdout, stderr
	// 监督进程退出后，孤儿后端可能仍继承 headless 输出管道。
	// 限制的是已退出进程的管道回收，不会终止仍存活的监督或业务进程。
	command.WaitDelay = 2 * time.Second
	configureChildProcess(command)
	return command
}

func main() {
	options, err := parseOptions(os.Args[1:])
	if err != nil {
		reportStartupError(options, err.Error())
		os.Exit(1)
	}
	executable, err := os.Executable()
	if err != nil {
		reportStartupError(options, fmt.Sprintf("SunYu ERP 无法确定安装目录：%v", err))
		os.Exit(1)
	}
	os.Exit(runApplication(executable, options))
}

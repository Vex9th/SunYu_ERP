// SunYu ERP 原生托盘启动器：单实例服务、自动打开网页、独立升级恢复。
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
	command := exec.Command(filepath.Join(root, "app", "SunYuService.exe"), "--root", root)
	command.Dir = root
	command.Env = append(os.Environ(), "SUNYU_SUPERVISED=1")
	command.Stdin, command.Stdout, command.Stderr = stdin, stdout, stderr
	// 监督进程退出后，孤儿后端可能仍继承 headless 输出管道。
	// 限制的是已退出进程的管道回收，不会终止仍存活的监督或业务进程。
	command.WaitDelay = 2 * time.Second
	configureChildProcess(command)
	return command
}

var version = "2.0.0-dev"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
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

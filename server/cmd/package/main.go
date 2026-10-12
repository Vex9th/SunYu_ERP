// Command package creates the native Windows release and update assets.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"sunyu.local/erp/internal/distribution"
)

func run(args []string, out, diagnostics io.Writer) error {
	var options distribution.Options
	flags := flag.NewFlagSet("sunyu-package", flag.ContinueOnError)
	flags.SetOutput(diagnostics)
	flags.StringVar(&options.Version, "version", "", "发布版本，前端需使用相同 SUNYU_VERSION 构建")
	flags.StringVar(&options.BackendVersion, "backend-version", "", "后端版本，默认等于 version")
	flags.StringVar(&options.LauncherVersion, "launcher-version", "", "启动器版本，默认等于 version")
	flags.StringVar(&options.BinDir, "bin-dir", "", "包含三个 Windows AMD64 EXE 的目录")
	flags.StringVar(&options.WebDir, "web-dir", "", "已经构建的前端资源目录")
	flags.StringVar(&options.Output, "output", "", "不存在或为空的发布输出目录")
	flags.StringVar(&options.Notes, "notes", "", "写入正式更新清单的发布说明")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("不支持额外位置参数")
	}
	result, err := distribution.Build(options)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil && !errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(os.Stderr, "打包失败：", err)
		os.Exit(1)
	}
}

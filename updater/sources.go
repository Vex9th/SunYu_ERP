package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

func (e *Engine) latestRelease() (string, Manifest, string, error) {
	var mirrorErr error
	if e.mirror != nil {
		if err := e.progress("checking", "正在从蓝奏检查正式版本", 0); err != nil {
			return "", Manifest{}, "", err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		release, err := e.mirror.latest(ctx)
		cancel()
		if err == nil {
			if compareVersion(release.manifest.Version, e.current) <= 0 {
				// 镜像可能因上传失败而落后；短暂核对主源，避免永久漏报新版。
				ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
				defer cancel()
				v, m, probeErr := e.githubReleaseContext(ctx)
				if probeErr == nil && compareVersion(v, release.manifest.Version) > 0 {
					return v, m, "", nil
				}
				if probeErr != nil {
					fmt.Fprintln(os.Stderr, "GitHub 补充检查未完成：", safeNetworkDetail(probeErr))
				}
			}
			return release.manifest.Version, release.manifest, release.archiveID, nil
		}
		mirrorErr = err
		fmt.Fprintln(os.Stderr, "蓝奏检查失败，回退 GitHub：", safeNetworkDetail(err))
		if err := e.progress("checking", "蓝奏暂不可用，正在通过 GitHub 检查", 0); err != nil {
			return "", Manifest{}, "", err
		}
	}
	v, m, err := e.githubRelease()
	if err != nil && mirrorErr != nil {
		err = errors.Join(fmt.Errorf("蓝奏：%w", mirrorErr), fmt.Errorf("GitHub：%w", err))
	}
	return v, m, "", err
}

func (e *Engine) githubRelease() (string, Manifest, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	return e.githubReleaseContext(ctx)
}

func (e *Engine) githubReleaseContext(ctx context.Context) (string, Manifest, error) {
	var m Manifest
	var release struct {
		Tag        string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if err := e.fetchJSONContext(ctx, latestURL, &release); err != nil {
		return "", m, fmt.Errorf("检查正式版本失败：%w", err)
	}
	latest := strings.TrimPrefix(release.Tag, "v")
	if release.Draft || release.Prerelease || !validVersion(latest) {
		return "", m, errors.New("正式版本信息无效")
	}
	// 旧正式版可能尚无清单；没有新版本时不请求清单。
	if compareVersion(latest, e.current) <= 0 {
		return latest, m, nil
	}
	address := "https://github.com/Vex9th/SunYu_ERP/releases/download/v" + latest + "/update-manifest-singlefile.json"
	if err := e.fetchJSONContext(ctx, address, &m); err != nil {
		return "", m, fmt.Errorf("读取更新清单失败：%w", err)
	}
	return latest, m, nil
}

func (e *Engine) downloadRelease(m Manifest, mirrorID, archive string) error {
	if mirrorID != "" && e.mirror != nil {
		if err := e.progress("downloading", "正在从蓝奏下载并校验；当前服务继续运行", 10); err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		err := e.mirror.download(ctx, mirrorID, archive)
		cancel()
		if err == nil {
			h, hashErr := hashFile(archive)
			if hashErr == nil && h == m.Archive.SHA256 {
				return nil
			}
			// 此文件是本任务刚下载成功的缓存，校验失败只清除该缓存。
			if removeErr := os.Remove(archive); removeErr != nil {
				return removeErr
			}
			err = errors.New("蓝奏更新包 SHA256 不匹配")
		}
		fmt.Fprintln(os.Stderr, "蓝奏下载失败，回退 GitHub：", safeNetworkDetail(err))
		if err := e.progress("downloading", "蓝奏下载未完成，正在改用 GitHub；当前服务继续运行", 10); err != nil {
			return err
		}
	}
	return e.download(m.Archive.URL, archive)
}

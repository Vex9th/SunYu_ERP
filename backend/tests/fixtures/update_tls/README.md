# 仅供 TLS 回归测试

这些证书及 `server.key` 只用于内存中的 TLS 握手，不用于真实服务，不加入任何系统信任库。
测试域名为 `api.github.com`，签发者为自建的 `SunYu ERP TEST ONLY CA`，实际 GitHub 不信任此证书。
CA 私钥不在仓库中，测试不依赖 OpenSSL 命令或外部网络。

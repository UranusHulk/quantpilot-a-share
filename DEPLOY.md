# QuantPilot 公网部署

## Cloudflare Pages 设置

仓库已包含 Pages Functions 和 `wrangler.toml`。在 Cloudflare Dashboard 中：

1. 打开 **Workers & Pages → Create application → Pages → Connect to Git**。
2. 连接 GitHub 并选择 `UranusHulk/quantpilot-a-share`。
3. Framework preset 选 **None**，Build command 填 `npm run build`，Build output directory 填 `dist`。
4. 点击 **Save and Deploy**。

Cloudflare 会通过 GitHub 自动构建和发布后续提交。部署成功后使用它提供的 `https://<项目名>.pages.dev` 地址，并检查首页及 `/health`。Pages 免费套餐通常不需要信用卡。

## 本机运行

需要 Node.js 20 或更新版本：

```powershell
node server.js
```

打开 `http://127.0.0.1:8080`。同一局域网内可通过本机局域网 IP 访问。

## 数据接口

静态页面由 Cloudflare Pages 托管；行情、股票池和回测 API 由 Pages Functions 在服务端请求腾讯行情、交易所目录和东方财富接口，浏览器使用同源 `/api/*` 路径。公开行情源可用性取决于上游服务对 Cloudflare 网络的响应。
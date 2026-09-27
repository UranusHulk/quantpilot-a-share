# QuantPilot A股量化研究平台

这是一个面向 A 股研究的网页工具，包含股票池、实时行情、策略实验室、历史回测和个股详情。

## 本地运行

```powershell
node server.js
```

浏览器打开 `http://127.0.0.1:8080/`。

## 公网部署

项目使用 Node.js HTTP 服务，云平台启动命令为：

```text
node server.js
```

服务会读取 `PORT` 环境变量，并监听 `0.0.0.0`，可部署到 Render、Railway、Fly.io 等 Node.js 云平台。

详细步骤见 [DEPLOY.md](DEPLOY.md)。

## 数据说明

实时行情来自腾讯公开行情接口，个股历史 K 线和公告来自东方财富公开接口。回测由服务端代码执行，不依赖大模型 API。当前不连接券商，也不会自动下单。

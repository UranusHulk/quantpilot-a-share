# QuantPilot A股量化研究平台

这是一个面向 A 股研究的网页工具，包含股票池、实时行情、策略实验室、历史回测和个股详情。

## 本地运行

需要 Node.js 20 或更新版本：

```powershell
node server.js
```

浏览器打开 `http://127.0.0.1:8080/`。

## 公网部署

支持 Cloudflare Pages：静态页面由 Pages 托管，实时行情、股票目录、个股详情和回测 API 由 Pages Functions 运行。GitHub 连接设置为构建命令 `npm run build`、输出目录 `dist`。详细配置见 [DEPLOY.md](DEPLOY.md)。

## 数据说明

实时行情来自腾讯公开行情接口，个股历史 K 线和公告来自东方财富公开接口。回测由服务端代码执行，不依赖大模型 API。当前不连接券商，也不会自动下单。
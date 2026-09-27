# QuantPilot 部署说明

## 本机运行

```powershell
npm start
```

打开 `http://127.0.0.1:8080`。

## 局域网访问

服务已监听 `0.0.0.0`。同一局域网设备可访问：

```text
http://本机局域网IP:8080
```

Windows 防火墙需要允许 Node.js 接收 TCP 8080 入站连接。

## 公网访问

`127.0.0.1` 只代表访问者自己的电脑，不能作为面向用户的网站地址。将项目推送到 GitHub 后，在 Render 创建 Web Service，使用：

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

部署完成后使用 Render 分配的 `https://...onrender.com` 地址。生产环境建议绑定自己的域名，并把行情接口放在服务端调用。

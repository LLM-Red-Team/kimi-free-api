# KIMI Free 服务

## 在线体验

https://udify.app/chat/Po0F6BMJ15q5vu2P

## 接入准备

从kimi获取refresh_token：进入kimi随便发起一个对话，然后F12打开开发者工具，从Application > Local Storage中找到refresh_token的值，这将作为API_KEY。

## 安装

请先安装好Node.js环境并且配置好环境变量，确认node命令可用。

安装依赖

```shell
npm i
```

安装PM2进行进程守护

```shell
npm i -g pm2
```

编译构建，看到dist目录就是构建完成

```shell
npm run build
```

启动服务

```shell
pm2 start dist/index.js --name "kimi-free-api"
```

查看服务实时日志

```shell
pm2 logs kimi-free-api
```

重启服务

```shell
pm2 reload kimi-free-api
```

停止服务

```shell
pm2 stop kimi-free-api
```

## 发起请求

目前支持与openai兼容的 `/v1/chat/completions` 接口

POST /v1/chat/completions

```json
{
    "messages": [
        {
            "role": "user",
            "content": "测试"
        }
    ],
    // 如果使用SSE流请设置为true
    "stream": false
}
```

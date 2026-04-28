# Rome

基于公网 MQTT 中转的远程命令行桥接工具。

Rome 的目标很直接：一台机器作为服务端等待连接，另一台机器作为客户端接入，然后在公网环境下远程控制 `Claude Code`、普通 shell 或 `cmd.exe`。当前版本使用 EMQX 公共 MQTT Broker，并对消息做 TLS 传输与端到端密封。

## 特性

- 不需要自建中转服务器
- 首次运行自动生成本地配置
- 消息端到端密封，公网 Broker 无法直接读明文
- 基于 `node-pty`，支持交互式终端
- Windows 默认使用 `cmd.exe`
- 服务端默认在启动时所在目录执行远程命令

## 安全模型

- 任何知道共享 `token` 的人，都拥有完整远程控制权限
- 消息内容在进入公共 Broker 前会被密封
- 仓库不会提交真实配置；`rome.config.json` 只在本地生成，并已加入 git 忽略

因此必须使用强随机 `token`，并只分享给可信对象。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 在服务端机器启动

Windows：

```bat
start-server.bat
```

Linux/macOS：

```bash
./start-server.sh
```

首次启动时，Rome 会自动生成本地 `rome.config.json`，并写入随机 `token`。

### 3. 把配置同步给客户端机器

只需要同步下面两个值：

- `brokerUrl`
- `token`

把服务端本地 `rome.config.json` 中这两个字段，复制到客户端本地 `rome.config.json` 即可。

可以先从 `rome.config.json.example` 复制一份模板。

### 4. 在客户端机器启动

Windows：

```bat
start-client.bat
```

Linux/macOS：

```bash
./start-client.sh
```

客户端会使用相同的 `brokerUrl` 和 `token` 自动连接。

## 命令行用法

服务端：

```bash
node bin/rome.js serve
```

客户端：

```bash
node bin/rome.js connect
```

### 服务端常用参数

- `--broker <url>`：覆盖 MQTT Broker 地址
- `--shell <cmd>`：设置默认远程命令
- `--args <args...>`：设置默认命令参数
- `--dir <path>`：设置远程命令工作目录
- `--token <token>`：覆盖共享 token
- `--keep`：会话结束后保持服务端继续运行

### 客户端常用参数

- `--broker <url>`：覆盖 MQTT Broker 地址
- `--cmd <cmd>`：指定远程启动命令
- `--args <args...>`：指定远程命令参数
- `--token <token>`：覆盖共享 token

## 配置文件

本地配置示例：

```json
{
  "brokerUrl": "mqtts://broker.emqx.io:8883",
  "token": "replace-with-a-random-32-plus-char-token",
  "client": {
    "cmd": "cmd.exe",
    "args": []
  },
  "server": {
    "shell": "cmd.exe",
    "args": [],
    "workDir": ""
  }
}
```

说明：

- 如果 `server.workDir` 为空，Rome 会使用服务端启动时的当前目录
- 如果 `rome.config.json` 不存在，或其中的 `token` 太弱，Rome 会自动重新生成本地配置

## 开发

```bash
npm run build
npm test
```

## 中转

默认 Broker：

- `mqtts://broker.emqx.io:8883`

参考：

- [EMQX Public MQTT Broker](https://www.emqx.com/en/mqtt/public-mqtt5-broker)

## 许可证

MIT

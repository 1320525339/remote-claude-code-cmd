# Rome

Remote shell bridge over a public MQTT relay.

Rome lets one machine wait as a remote shell host and another machine attach as a client. It is designed for simple cross-network use without owning a relay server. The current relay mode uses the public EMQX MQTT broker over TLS and seals each message end-to-end with a shared token.

## Features

- No self-hosted relay required
- Automatic local config generation on first run
- End-to-end sealed MQTT messages
- Interactive PTY support through `node-pty`
- Windows-friendly defaults with `cmd.exe`
- Works from the current server launch directory by default

## Security model

- Anyone who knows the shared token has full remote shell access
- Message contents are sealed before going through the public broker
- The repo does not ship a live token; `rome.config.json` is generated locally and ignored by git

Use a strong random token and share it only with trusted users.

## Quick start

### 1. Install

```bash
npm install
```

### 2. Start the server machine

Windows:

```bat
start-server.bat
```

Linux/macOS:

```bash
./start-server.sh
```

On first run, Rome creates a local `rome.config.json` with a generated token.

### 3. Share config with the client machine

Copy only the values of:

- `brokerUrl`
- `token`

from your local `rome.config.json` into the client machine's local `rome.config.json`.

You can start from `rome.config.json.example`.

### 4. Start the client machine

Windows:

```bat
start-client.bat
```

Linux/macOS:

```bash
./start-client.sh
```

The client auto-connects using the shared broker and token.

## CLI

Server:

```bash
node bin/rome.js serve
```

Client:

```bash
node bin/rome.js connect
```

Useful server options:

- `--broker <url>` override MQTT broker URL
- `--shell <cmd>` set default remote shell
- `--args <args...>` set default shell args
- `--dir <path>` set remote working directory
- `--token <token>` override shared token
- `--keep` keep server alive after a session ends

Useful client options:

- `--broker <url>` override MQTT broker URL
- `--cmd <cmd>` command to start remotely
- `--args <args...>` args for the remote command
- `--token <token>` override shared token

## Config

Example local config:

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

Notes:

- If `server.workDir` is empty, Rome uses the current directory where the server was started
- If `rome.config.json` is missing or has a weak token, Rome generates a new local one automatically

## Development

```bash
npm run build
npm test
```

## Relay

Default broker:

- `mqtts://broker.emqx.io:8883`

Reference:

- [EMQX Public MQTT Broker](https://www.emqx.com/en/mqtt/public-mqtt5-broker)

## License

MIT

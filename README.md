# Laminar OpenCode plugin

Trace your [OpenCode](https://opencode.ai) sessions in [Laminar](https://laminar.sh). Every turn of a conversation shows up as its own trace, with the LLM calls and tool calls OpenCode made along the way, grouped by session.

## Installation

The plugin works with OpenCode V2 and with OpenCode V1 (1.4 and newer). Add it to your `opencode.json`.

OpenCode V2 ([plugin docs](https://opencode.ai/v2/docs/plugins)):

```json
{
    "$schema": "https://opencode.ai/config.json",
    "plugins": [
        "@lmnr-ai/opencode-plugin"
    ]
}
```

OpenCode V1 ([plugin docs](https://opencode.ai/docs/plugins/#load-order)):

```json
{
    "$schema": "https://opencode.ai/config.json",
    "plugin": [
        "@lmnr-ai/opencode-plugin"
    ]
}
```

Set environment variable:

```bash
export LMNR_PROJECT_API_KEY="<YOUR KEY>" # in the shell where you launch opencode
```

You can get a project API key in your Laminar project settings. The plugin also reads `.env` files from your project directory, so you can put the key there instead. On V2 you can also pass it as a plugin option (see [Configuration](#configuration)).

If `LMNR_PROJECT_API_KEY` is not set, the plugin does nothing.

## What you see in Laminar

- **One trace per turn.** Each message you send starts an `opencode turn` span. The model calls and tool calls that answer it are nested underneath, so a turn reads top to bottom.
- **Sessions grouped together.** Turns carry the OpenCode session ID, so a whole conversation is one session in Laminar.
- **Subagents linked to their parent.** When OpenCode spawns a subagent (the `subagent` tool in V2, `task` in V1), the subagent's spans are nested under the tool call that started them.

## How it works

**OpenCode V2.** The plugin subscribes to OpenCode's event stream and builds the spans itself: one span per model step (with the request messages, the response, token usage and cost) and one per tool call. It reads each step's messages from the `context` session hook and records them in OpenCode's own message format. V2 removed the `experimental.openTelemetry` flag, so the plugin doesn't use it.

**OpenCode V1.** The plugin turns on OpenCode's experimental OpenTelemetry flag and adds a Laminar span processor. The processor saves each conversation turn as its own trace, groups traces by session ID, and adds the attributes that power Laminar-specific features.

To parent a turn under a span from your own code, pass a serialized Laminar span context as `lmnrSpanContext` in the prompt metadata (V2) or in a synthetic message part (V1).

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `LMNR_PROJECT_API_KEY` | (required) | Laminar project API key |
| `LMNR_BASE_URL` | `https://api.lmnr.ai` | Point at a self-hosted Laminar instance |
| `LMNR_GRPC_PORT` | `8443` for Laminar Cloud, SDK default otherwise | gRPC port for the exporter |

On V2, `projectApiKey` and `baseUrl` plugin options take precedence over the environment:

```json
{
    "plugins": [
        {
            "package": "@lmnr-ai/opencode-plugin",
            "options": { "baseUrl": "https://laminar.example.com" }
        }
    ]
}
```

## Learn more

- [OpenCode integration docs](https://laminar.sh/docs/integrations/opencode)
- [Laminar](https://github.com/lmnr-ai/lmnr) (open source, self-hostable)

## License

[Apache-2.0](LICENSE)

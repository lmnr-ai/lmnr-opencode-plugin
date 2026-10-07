# Laminar OpenCode plugin

Trace your [OpenCode](https://opencode.ai) sessions in [Laminar](https://laminar.sh). Every turn of a conversation shows up as its own trace, with the LLM calls and tool calls OpenCode made along the way, grouped by session.

## Installation

In your [opencode.json](https://opencode.ai/docs/plugins/#load-order):

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

You can get a project API key in your Laminar project settings. The plugin also reads `.env` files from the directory where you launch OpenCode, so you can put the key there instead.

If `LMNR_PROJECT_API_KEY` is not set, the plugin does nothing.

## What you see in Laminar

- **One trace per turn.** Each message you send starts an `opencode turn` span. The model calls and tool calls that answer it are nested underneath, so a turn reads top to bottom.
- **Sessions grouped together.** Turns carry the OpenCode session ID, so a whole conversation is one session in Laminar.
- **Subagents linked to their parent.** When OpenCode spawns a subagent with the `task` tool, the subagent's spans are nested under the `task` tool call that started them.

## OpenTelemetry integration

OpenCode has an experimental config flag to enable OpenTelemetry. The plugin turns it on for you when it is loaded.

On top of raw OTEL, Laminar injects a custom span processor that saves each conversation turn as a separate trace and groups traces by session ID. It also adds attributes on spans that power Laminar-specific features.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `LMNR_PROJECT_API_KEY` | (required) | Laminar project API key |
| `LMNR_BASE_URL` | `https://api.lmnr.ai` | Point at a self-hosted Laminar instance |
| `LMNR_GRPC_PORT` | `8443` for Laminar Cloud, SDK default otherwise | gRPC port for the exporter |

## Learn more

- [OpenCode integration docs](https://laminar.sh/docs/integrations/opencode)
- [Laminar](https://github.com/lmnr-ai/lmnr) (open source, self-hostable)

## License

[Apache-2.0](LICENSE)

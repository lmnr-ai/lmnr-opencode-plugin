# Laminar Opencode plugin

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

## Opentelemetry integration

Opencode has an experimental config flag to enable opentelemetry. We enable it if Laminar plugin is added.

## What you get (on top of raw OTEL)

Laminar injects a custom span processor that will make sure each conversation turn is saved as a separate trace, and conversation sessions are grouped by session ids so that it's easier to view them.

The custom span processor also adds some additional attributes on spans that power Laminar-specific features.

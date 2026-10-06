# NEXUS API Audit Notes

## Scope
This audit checks whether the NEXUS rebrand changed provider endpoints, authentication behavior, request headers, model discovery, or the historical free-model path. No credentials are recorded.

## Local configuration
No user model configuration file was found at the checked `~/.nexus` locations. The sandbox exposes an OpenAI-compatible environment configuration with the key redacted; no NEXUS, Groq, OpenRouter, Ollama, Anthropic, or Gemini credentials were observed. The CLI reported zero stored credentials and one environment provider: OpenAI.

## Provider and endpoint inventory
The model catalog loader uses `NEXUS_MODELS_URL` when set, with the upstream fallback `https://models.opencode.ai`. The upstream catalog endpoint returned HTTP 200. Its historical public provider object is `opencode`, with environment variable `OPENCODE_API_KEY`, SDK `@ai-sdk/openai-compatible`, API base `https://opencode.ai/zen/v1`, and display name `OpenCode Zen`.

Other endpoint families found in source include the Zenmux API at `https://zenmux.ai/api/v1`; GitLab fallback/API URLs; Snowflake Cortex URLs constructed from the account hostname; Google Cloud APIs and OAuth scopes; NEXUS product URLs such as `https://nexus.ai/`; optional MCP endpoints at `https://mcp.exa.ai/mcp` and `https://search.parallel.ai/mcp`; and generic GitHub repository URLs. Provider-specific URLs are normally supplied by the model catalog or user configuration rather than hardcoded in the adapter.

## Branding and authentication audit
Generic request User-Agent values now use `nexus/${InstallationVersion}`. Generic provider attribution headers use NEXUS values such as `HTTP-Referer: https://nexus.ai/`, `X-Title: nexus`, `X-Source: nexus`, and one `X-BILLING-INVOKE-ORIGIN: NEXUS`. No `X-Opencode-*` or `Opencode-*` request headers were found in the inspected NEXUS source. These NEXUS attribution headers are potentially relevant only to providers that accept or inspect attribution; they are not authentication headers.

The upstream Zen provider is different: its catalog metadata remains vendor-owned and uses `https://opencode.ai/zen/v1`, `OPENCODE_API_KEY`, and provider ID `opencode`. These strings must remain unchanged for compatibility with the external service. The vendor client tarball and external plugin package names are also intentionally preserved.

## Compatibility fixes applied
The model catalog fallback was restored from the incorrect rebranded URL to `https://models.opencode.ai`, while retaining the user-overridable `NEXUS_MODELS_URL` flag. Runtime external plugin installation was restored to the published package name `@opencode-ai/plugin` and pinned to the checked-out compatible published version `1.18.19`, instead of attempting to install the unpublished `@nexus-ai/plugin` package at a NEXUS preview version. The provider loader now exposes an internal `opencode` compatibility alias alongside the NEXUS-internal alias, allowing the upstream catalog provider ID to load without changing NEXUS UI branding.

## Model verification
The rebuilt binary lists these upstream public-provider models: `opencode/big-pickle`, `opencode/hy3-free`, `opencode/mimo-v2.5-free`, `opencode/muse-spark-1.2-contributor-free`, `opencode/nemotron-3-ultra-free`, `opencode/nemotron-3.5-lightning-free`, and `opencode/x-preview-f-free`. A direct request to `https://opencode.ai/zen/v1/chat/completions` using the public compatibility key and `big-pickle` returned HTTP 200 with `cost: "0"`, proving the upstream free endpoint is live and accepts the public path.

The first NEXUS CLI smoke test timed out before producing an answer. Logs showed the request selected `providerID=opencode`, `modelID=big-pickle`, and then reported a separate development-build warning because it tried to install `@opencode-ai/plugin@0.0.0-main-...`, a version that is not published. After pinning the external plugin to `1.18.19`, a release-version build completed and reported `1.18.19`; the prior warning was from the earlier development binary and is not evidence of a current endpoint rejection. The rebuilt release-version CLI was then tested in raw JSON mode. It selected `providerID=opencode` and `modelID=big-pickle`, reached the provider, and received `AI_APICallError: Error from provider (Console): Rate limit exceeded. Please try again later.` This is a provider-side quota/rate-limit response, not a branding, endpoint, or authentication-header rejection.

## Current conclusion
The NEXUS rebrand did break model discovery and runtime plugin bootstrap by replacing vendor-owned catalog/package identifiers. Those regressions have been corrected locally. The upstream free model path is live and reachable. The final working-status classification is **working at the endpoint and authentication-compatibility layers, but currently rate-limited by the upstream free service during CLI testing**. No local model or generic free-tier replacement is justified at this stage.


## Release verification
The installer repository target is the official `ravipacharpro-jpg/nexus-Official` repository. Release binaries are published through this repository's GitHub Releases page, and installation scripts download from its `main` branch.

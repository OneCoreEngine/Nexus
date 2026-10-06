import { Effect, Layer } from "effect"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@nexus-ai/core/provider"
import { ModelV2 } from "@nexus-ai/core/model"

export namespace ProviderTest {
  export function model(override: Partial<Provider.Model> = {}): Provider.Model {
    const id = override.id ?? ModelV2.ID.make("gpt-5.2")
    const providerID = override.providerID ?? ProviderV2.ID.make("openai")
    return {
      id,
      providerID,
      name: "Test Model",
      capabilities: {
        toolcall: true,
        attachment: false,
        reasoning: false,
        temperature: true,
        interleaved: false,
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
      },
      api: { id, url: "https://example.com", npm: "@ai-sdk/openai" },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 200_000, output: 10_000 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2025-01-01",
      ...override,
    }
  }

  export function info(override: Partial<Provider.Info> = {}, mdl = model()): Provider.Info {
    const id = override.id ?? mdl.providerID
    return {
      id,
      name: "Test Provider",
      source: "config",
      env: [],
      options: {},
      models: { [mdl.id]: mdl },
      ...override,
    }
  }

  export function fake(override: Partial<Provider.Interface> & { model?: Provider.Model; info?: Provider.Info } = {}) {
    const {
      model: overrideModel,
      info: overrideInfo,
      fallbackModels: overrideFallbackModels,
      ...serviceOverride
    } = override
    const mdl = overrideModel ?? model()
    const row = overrideInfo ?? info({}, mdl)
    return {
      model: mdl,
      info: row,
      layer: Layer.succeed(
        Provider.Service,
        Provider.Service.of({
          list: serviceOverride.list ?? Effect.fn("TestProvider.list")(() => Effect.succeed({ [row.id]: row })),
          getProvider:
            serviceOverride.getProvider ??
            Effect.fn("TestProvider.getProvider")((providerID) => {
              if (providerID === row.id) return Effect.succeed(row)
              return Effect.die(new Error(`Unknown test provider: ${providerID}`))
            }),
          getModel:
            serviceOverride.getModel ??
            Effect.fn("TestProvider.getModel")((providerID, modelID) => {
              if (providerID === row.id && modelID === mdl.id) return Effect.succeed(mdl)
              return Effect.die(new Error(`Unknown test model: ${providerID}/${modelID}`))
            }),
          getLanguage:
            serviceOverride.getLanguage ??
            Effect.fn("TestProvider.getLanguage")(() =>
              Effect.die(new Error("ProviderTest.getLanguage not configured")),
            ),
          closest:
            serviceOverride.closest ??
            Effect.fn("TestProvider.closest")((providerID) =>
              Effect.succeed(providerID === row.id ? { providerID: row.id, modelID: mdl.id } : undefined),
            ),
          getSmallModel:
            serviceOverride.getSmallModel ??
            Effect.fn("TestProvider.getSmallModel")((providerID) =>
              Effect.succeed(providerID === row.id ? mdl : undefined),
            ),
          defaultModel:
            serviceOverride.defaultModel ??
            Effect.fn("TestProvider.defaultModel")(() => Effect.succeed({ providerID: row.id, modelID: mdl.id })),
          fallbackModels: overrideFallbackModels ?? (() => Effect.succeed([])),
          rotationKeyCount: serviceOverride.rotationKeyCount ?? (() => Effect.succeed(0)),
          currentKey: serviceOverride.currentKey ?? (() => Effect.succeed(undefined)),
          invalidateLanguage: serviceOverride.invalidateLanguage ?? (() => Effect.void),
        }),
      ),
    }
  }
}

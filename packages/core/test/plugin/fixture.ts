import { AgentV2 } from "@opencode-ai/core/agent"
import { AISDK } from "@opencode-ai/core/aisdk"
import { Catalog } from "@opencode-ai/core/catalog"
import { CommandV2 } from "@opencode-ai/core/command"
import { Credential } from "@opencode-ai/core/credential"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { Npm } from "@opencode-ai/core/npm"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { Reference } from "@opencode-ai/core/reference"
import { SkillV2 } from "@opencode-ai/core/skill"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { tempLocationLayer } from "../fixture/location"

type PluginTestServices =
  | FileSystem.Service
  | FSUtil.Service
  | Location.Service
  | Npm.Service
  | Credential.Service
  | EventV2.Service
  | AgentV2.Service
  | AISDK.Service
  | Catalog.Service
  | CommandV2.Service
  | Integration.Service
  | Reference.Service
  | SkillV2.Service
  | PluginV2.Service
  | HttpClient.HttpClient

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
) as Layer.Layer<PluginTestServices>

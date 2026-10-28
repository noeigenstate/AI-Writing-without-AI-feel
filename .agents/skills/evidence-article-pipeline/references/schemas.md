# `run.json` 数据契约

`run.json` 是流程的机器可验收清单。Markdown 文件负责供人阅读，JSON 负责证明所有关系已显式记录。

## 最小示例

```json
{
  "schema_version": 1,
  "topic": "示例主题",
  "status": "passed",
  "research": {
    "iterations": 3,
    "saturated": true,
    "limit_reached": false,
    "stop_reason": "连续两轮无实质新增",
    "keyword_history": [["初始关键词"], ["补充关键词"]]
  },
  "sources": [
    {
      "id": "S01",
      "title": "材料标题",
      "url": "https://example.com/source",
      "source_type": "official",
      "retrieved_at": "2026-09-16",
      "accessible": true
    }
  ],
  "claims": [
    {
      "id": "C01",
      "text": "可验证的最小事实陈述",
      "source_ids": ["S01"],
      "objective": true,
      "confidence": "confirmed"
    }
  ],
  "clue_graph": {
    "primary_axis": "timeline",
    "nodes": [
      {
        "id": "N01",
        "label": "节点标题",
        "claim_ids": ["C01"],
        "source_ids": ["S01"],
        "media_ids": []
      }
    ],
    "edges": []
  },
  "media": [],
  "draft": {
    "path": "article.md",
    "length": {
      "method": "plain_content_characters",
      "min": 1800,
      "max": 2200,
      "actual": 2050,
      "pass": true
    }
  },
  "validation": {
    "facts": true,
    "length": true,
    "citations": true,
    "media_match": true,
    "topic_alignment": true,
    "evidence_boundary_disclosed": true,
    "less_ai_tone": "passed"
  },
  "repair_cycles": 1,
  "artifacts": {
    "research_md": "research.md",
    "clue_graph_md": "clue-graph.md",
    "media_manifest_md": "media-manifest.md",
    "article_md": "article.md",
    "validation_md": "validation.md"
  }
}
```

## 枚举与约束

- `status`: `passed`、`limited` 或 `incomplete`。
- `research.iterations`: 1 到 10。
- `research.saturated`: 证据是否达到饱和。
- `research.limit_reached`: 是否到达第 10 轮硬上限。
- `source_type`: `primary`、`official`、`paper`、`media` 或 `commentary`。
- `confidence`: `confirmed`、`probable`、`disputed` 或 `unverified`。
- `repair_cycles`: 0 到 3。
- `validation.less_ai_tone`: `passed`、`not_applicable`、`not_run` 或 `failed`。通过状态只允许前两项。
- `validation.evidence_boundary_disclosed`: `limited` 状态下必须为 `true`；表示正文没有填补未解决缺口，并在关键缺口影响主题时明确限定结论。
- 所有 `claim.source_ids` 必须引用存在且可访问的来源。
- 所有节点至少引用一个存在的事实；节点中的来源和媒体编号也必须存在。

## 媒体对象

真实来源图：

```json
{
  "id": "M01",
  "origin": "source",
  "url_or_path": "https://example.com/image.jpg",
  "source_url": "https://example.com/page",
  "license": "来源页版权说明或合理使用依据",
  "caption": "准确图注",
  "alt": "可访问性替代文本",
  "node_ids": ["N01"],
  "claim_ids": ["C01"],
  "supports_fact": true,
  "disclosure": ""
}
```

生成示意图：

```json
{
  "id": "M02",
  "origin": "generated",
  "url_or_path": "images/illustration.png",
  "source_url": "",
  "license": "",
  "caption": "模型生成示意图：抽象流程",
  "alt": "抽象流程示意",
  "node_ids": ["N01"],
  "claim_ids": [],
  "supports_fact": false,
  "disclosure": "模型生成示意图，不作为事实证据"
}
```

`generated` 媒体不得设置 `supports_fact: true`，也不得绑定 `claim_ids`。真实来源图用于事实证明时必须提供 `source_url`。

## 通过条件

`status: passed` 需要同时满足：

1. 研究已饱和且轮次没有超过 10；
2. 所有事实和节点引用关系有效；
3. 生成图未承担事实证明；
4. 字数通过；
5. 事实、引用、图文匹配、主题一致性均为 `true`；
6. 去 AI 味为 `passed` 或 `not_applicable`；
7. 修复周期没有超过 3；
8. 五个 Markdown 产物均存在。

`status: limited` 也是可交付结果，需要同时满足：

1. `research.iterations` 为 10、`research.saturated` 为 `false`、`research.limit_reached` 为 `true`；
2. 至少存在一条有可访问来源的客观事实；
3. 线索图只使用已有事实，不把缺口变成节点或因果；
4. 字数、事实、引用、图文匹配和主题一致性门禁通过；
5. `validation.evidence_boundary_disclosed` 为 `true`；
6. 去 AI 味为 `passed` 或 `not_applicable`；
7. 修复周期没有超过 3，五个 Markdown 产物均存在。

到第 10 轮且一条可核验事实都没有时，必须使用 `status: incomplete`，不能用 `limited` 绕过事实门禁。

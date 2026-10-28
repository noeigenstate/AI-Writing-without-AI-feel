# lieflat-less-ai-tone attribution

This project adapts the whitelist rules from:

- Repository: <https://github.com/larashero3-dotcom/lieflat-less-ai-tone>
- Pinned upstream commit: `27d29232f10124db904ca9c0536d0b67cb3b2833`
- Pinned ruleset: <https://github.com/larashero3-dotcom/lieflat-less-ai-tone/blob/27d29232f10124db904ca9c0536d0b67cb3b2833/SKILL.md>
- Upstream description: an AI-tone removal skill grounded in a 2.83-million-character corpus study
- Copyright: © 2026 shiujan
- License: MIT; see [LICENSE](./LICENSE)

## Local adaptation

The upstream skill is applied only as a post-draft cleanup for Chinese WeChat
article generation. The local adapter:

1. keeps the upstream whitelist-only and information-conservation boundaries;
2. requests paragraph patches tagged with upstream rule IDs;
3. rejects patches that lack a matching trigger or alter citations, URLs,
   numbers, English identifiers, or quoted text;
4. preserves paragraph count/order and all article planning/media metadata;
5. skips the model call when no whitelist trigger is present;
6. treats the pass as non-blocking so an otherwise valid sourced article is
   never lost because the optional cleanup fails.

The upstream research corpus is not redistributed.

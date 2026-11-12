<!-- PR title: Add ruaibeite/dsh-usage-stats -->

Adds one entry file:

`data/plugins/ruaibeite__dsh-usage-stats.yml`

- Single entry; no other files touched, and the generated READMEs are left untouched.
- The repository declares `dsh.bundle` in `package.json` (with `cordis.patch.yml`) and ships real host + client code.
- `dsh-plugin` topic is set on the repository.
- Description states what the code does: the host half scans the local session logs (`$DSH_HOME/sessions/**/session.v4.jsonl.zstd`), parses their multi-frame zstd container, and folds the provider-reported usage with the same accounting as DSH's own `tokenUsage` projection; the client half adds a **Usage** section to Settings with two scene cards (Chat and Code, each with input, output, cache-read and cache-write rows and a web-search count), a daily token bar chart switchable between scene and model grouping with a per-day tooltip, and a per-model table that merges one model id across providers with share bars and an exact total row.
- Chat / Code is a documented mapping, not a DSH product name: Code = sessions that ran a code-execution tool, Chat = sessions that ran none of them. Agent Teams tools are recognised but do not form a separate scene.
- Icon is a GitHub-hosted raster (`assets/icon-180.png`); three real screenshots are declared in the repository's own `screenshots.json` (`assets/screenshot-usage-light.png`, `screenshot-usage-models.png`, `screenshot-usage-dark.png`: light scene view, model grouping, dark theme).
- No npm package; installs from GitHub. The repository was created immediately before this PR, so the submission gate's 1-day repository-age check will fail until it clears on its own; nothing else is pending.

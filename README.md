# Issue labels to BasedAgents tasks

This workflow lets a repository maintainer publish their own issue as a **free** BasedAgents task by adding the `bounty` label. It uses the official BasedAgents SDK, pinned to version 0.10.1, and signs with the repository's agent keypair. It does not attach money or use a payment wallet.

Posted tasks and their source links are public. Only label issue content that you intend to publish.

## Setup

1. Copy `.github/workflows/basedagents-task.yml` to the **default branch** of a repository you control. Enable GitHub Actions and permit `GITHUB_TOKEN` to write issues. The workflow declares only `contents: read` and `issues: write`.
2. In **Settings → Secrets and variables → Actions → Variables**, set `BASEDAGENTS_DRY_RUN` to `true` before testing. On the issue-label trigger, an unset variable means real publishing, so set this first.
3. Create a `bounty` label. Optionally create one category label: `bounty:code`, `bounty:research`, `bounty:data`, `bounty:content`, or `bounty:automation`. With no category label, the category is `code`. Multiple valid category labels fail clearly. Other labels are ignored.
4. For real publishing, register a BasedAgents agent and store the **complete JSON content** of its keypair file in the Actions repository secret `BASEDAGENTS_KEYPAIR`. Both current `{ "publicKey": "hex", "privateKey": "hex" }` and the official CLI's supported legacy shape work. Never commit or print the file. Dry runs need **no keypair secret**.
5. Add the category label first, then `bounty`. The label event runs the workflow. Inspect **Actions → Publish labeled issues to BasedAgents**. During testing, keep the variable `true`; no live tasks, comments, or label changes are made.
6. When ready to publish, change the variable to `false`. Remove and re-add `bounty`, or use **Run workflow** with that issue number and uncheck `dry_run`. The manual switch defaults to `true`; either switch being `true` always selects dry run.

## Fields and behavior

- The title is the issue title, truncated safely to at most 200 UTF-16 units.
- The description is the issue body followed by a blank line and `Source: <issue URL>`. The source is always preserved. The body is shortened as needed so the **entire description** stays within the API's 10,000-character limit. Null bodies are supported.
- The task category comes from the optional category label; `output_format` is `json`. No bounty or escrow field is sent.
- After successful publishing, the workflow comments the task URL on the same issue and adds `bounty:posted` (creating that label if necessary).
- If `bounty:posted` is already present, it does nothing. Per-issue concurrency and fetching live labels prevent overlapping label events/manual reruns from double posting. Keep manual issue numbers in ordinary decimal form, without leading zeroes.
- If the bot comment exists but adding the posted label failed, a rerun restores the label without creating another task. If the task was created but the comment failed, the run fails with recovery instructions: copy the task URL from the log to a comment and add `bounty:posted` **before rerunning**. The registry has no documented cross-service transaction/idempotency guarantee; a timeout at the posting request also needs inspection of the agent's task board before retrying.
- The workflow fetches issues only from `context.repo`, rejects pull requests, and never checks out or executes issue content. A constant Node.js bridge passes task data from a JSON file to the official SDK; issue text is never shell code, JavaScript, or CLI options. It masks the keypair and its fields and removes the temporary key and task files in `finally`.

## Dry-run verification

Only use a repository you own/control. Set `BASEDAGENTS_DRY_RUN=true`, create a test issue, and add `bounty:automation` then `bounty`. The run should contain `DRY RUN: no BasedAgents request, comments, or label changes.` followed by one JSON object containing the exact proposed title, category, description, and output format. Embedded newlines are JSON-escaped; decoding this object gives the exact text that would be posted.

For a manual preview, run the workflow with an issue number and the default checked `dry_run` input. Confirm that no issue comment, `bounty:posted` label, or live BasedAgents task was created. Run `actionlint .github/workflows/basedagents-task.yml` to check workflow syntax. The accompanying `tests/workflow.test.cjs` tests the actual embedded script with mocked GitHub/process calls, including secret handling and partial-failure recovery; it never connects to BasedAgents.

Run the local tests from the repository root (Node.js 22 or newer):

```sh
npm install --prefix .test-runtime --ignore-scripts --no-audit --no-fund basedagents@0.10.1
node --test tests/workflow.test.cjs
```

On Windows PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`. The SDK fixture stays in the ignored `.test-runtime` directory; the final test signs a generated throwaway key against a mocked offline transport, never a live API.

## Turn it off

Set `BASEDAGENTS_DRY_RUN=true` to keep previews without publishing. To stop all runs, disable the workflow from its Actions menu or remove the YAML. Remove the repository keypair secret if it is no longer needed. Existing tasks must be managed separately in BasedAgents; disabling this workflow does not cancel them.

## Provenance

Created by the `ysyhlly-codex` Codex AI agent with real local validation and a GitHub Actions dry-run in a repository controlled by `ysyhlly`. No human review is claimed. Test evidence is included with the public delivery; this demo never posts test tasks to the live board.

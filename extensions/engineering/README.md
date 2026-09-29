# Engineering workflows

Open **Launch agents** beside the terminal tab controls. Enter a goal and select
**Discuss before implementation**. Orca opens a normal agent conversation in the
current workspace using `grill-with-docs`. The agent inspects the project, asks
one question per turn, records terminology in `GLOSSARY.md` and decisions in
`docs/adr`, then asks you to approve the plan before implementing it. This is
agent guidance, not a filesystem sandbox or an enforced approval gate.

The same selector exposes all 20 skills from Matt Pocock's engineering folder.
Implementation workflows may edit code; choose them after planning. Workflow
context is supplied in the initial prompt, so the provider does not need a
proprietary Skill tool. Continue the discussion in the new agent tab. For a new
group, put the approved plan's file path in the group goal and assign tasks.
There is no automatic handoff from the interview to a group.

## Source and adaptation

- Upstream: https://github.com/mattpocock/skills/tree/d81f3a183412e71a5b1e84ca21bc1a35eea03a60/skills/engineering
- License: [MIT](vendor/LICENSE), copyright Matt Pocock.
- All engineering source files are preserved verbatim in `vendor/skills/engineering`.
- `grilling` and `writing-for-agents` from productivity are included dependencies.
- [source.json](source.json) records the upstream revision and SHA-256 of every
  vendored file. The generated catalog embeds Markdown and local reference docs.
- `src/shared/engineering-workflow.ts` owns Orca's dependency selection and prompt
  adapter. It explicitly overrides upstream grilling's multi-question rounds
  with the user's chosen one-question dialogue. Original source stays untouched.

Provider-specific tools, external trackers, and other skills mentioned as optional
next steps are not installed automatically. The adapter tells the agent to use
available capabilities and report missing ones. Selecting a workflow does not
install skills globally or modify the project's agent configuration.

## Updating

Review the new upstream revision and license, replace the vendored directories,
update `revision` in `generate.mjs`, and review dependencies in the prompt adapter.
Run `node extensions/engineering/generate.mjs`, then the engineering workflow
tests and the normal Orca checks. `node extensions/engineering/generate.mjs
--check` verifies that the catalog and provenance match the checked-in files.
Do not format vendored sources. Commit source, provenance and generated catalog
together. No runtime network download is required.

This directory is the source package boundary for a future plugin. The current
adapter is built into Orca; it is not yet a separately installable Orca plugin.

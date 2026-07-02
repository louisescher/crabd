# crab'd

A forge-agnostic, multi-provider coding agent for CI. crab'd delivers the `@claude`-style
workflow (answer `@`-mentions, review pull requests, implement whole issues) but on **any model**
(Anthropic, OpenAI, OpenRouter, local via Ollama) on GitHub and Forgejo.

For more information, read the [documentation](https://crabd.lou.gg).

## Using the action

```yaml
- uses: louisescher/crabd@v0
  with:
    model: anthropic/claude-sonnet-5
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

crab'd ships as a **Docker action** (`ghcr.io/louisescher/crabd`).
`workflows/github/crabd.yml` and `workflows/forgejo/crabd.yml` for full examples.

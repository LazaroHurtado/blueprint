# Example workflow

Open `review-and-refine.blueprint.json` in Blueprint. It demonstrates an agent,
a structured decision, a bounded repeat loop with its own body, and a
complementary branch join.

Opening and editing it are local operations. The example grants no agent tools or
MCP servers. An exported run still uses Copilot CLI's own configuration/context
behavior and makes paid/allowance-counted requests; review where you run it and
what inputs you provide. The loop may fail at its
three-iteration cap instead of converging; that is deliberate, bounded behavior.

After reviewing and exporting it, a suitable workflow argument is:

```json
{
  "task": "Create a short checklist for reviewing documentation before release."
}
```

Do not paste secrets or confidential tasks into examples used in public reports.
The repository checker validates that the checked-in example can be imported and
exported; it does not execute agents.

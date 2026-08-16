---
name: blog-post
description: Turn a topic into a fact-checked, edited blog post
inputs: [topic]
steps:
  - agent: researcher      # produces `findings`
  - agent: writer          # reads `findings`, produces `draft`
  - agent: critic          # reads `draft` + `findings`, produces `critique`
  - agent: writer          # reads `draft` + `critique`, overwrites `draft` (revised)
    as: reviser
---

Research the topic, draft a post from the findings, have an editor critique the
draft, then send it back to the writer to revise.

Because the context is **inclusive**, the final `writer` step can see the
original `findings`, its own first `draft`, and the `critique` all at once — so
the revision is grounded in the sources, not just the editor's notes.

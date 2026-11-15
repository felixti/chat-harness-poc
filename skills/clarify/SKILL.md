---
name: clarify
description: Ask the user a few focused multiple-choice questions before acting when missing context would change the result (audience, goal, format, scope, deadline, a decision only they can make), or when the user asks to be interviewed ("me pergunte", "grill me", "vamos refinar"). Uses the ask_user tool, which shows clickable options in the chat.
---

# Clarify

A light version of the grilling method: ask only what changes the work, recommend an answer for
every question, and get to the deliverable fast.

## When to ask

Ask before acting only if at least one of these is unknown and would change the result:
- **Audience** (diretoria, time, cliente), which changes depth, tone and format.
- **Goal or decision** the work must support.
- **Format or size** (deck vs. document vs. dashboard, 5 vs. 20 slides).
- **Scope or data** (which period, region, product, file).
- **Constraint** (deadline, brand, mandatory content).

Do not ask:
- About facts you can find yourself (files, memory, web, connectors). Look them up.
- When the request is clear, or when a sensible default exists. Act and state the assumption in one line.
- About style details the skills already decide (layouts, themes, typography).

When the user explicitly asks to be interviewed or to refine an idea, run up to 3 rounds instead.

## How to ask

1. Map the decisions as a tree. The **frontier** is the set of questions you can ask now without
   guessing earlier answers. Ask the whole frontier in one round, with at most 3 questions.
2. Call `ask_user` once per round:
   - `question`: one sentence, in the user's language.
   - `options`: 2 to 4 concrete options (short `label`, optional one-line `description`).
   - `recommended`: the label you would choose, and why, in its description.
   - `id`: short slug (audience, format, period).
3. After the call, stop and wait. The user's answers come back as the next message.
4. Next round only if the answers opened new questions that change the result; at most 2 rounds
   (3 when the user asked to be interviewed).
5. Then act. Start the answer with the decisions in one line ("Deck de 8 slides para a diretoria,
   foco em custo."), then do the work.

If the user skips the questions, continue with your recommended options and say so in one line.

Adapted from mattpocock/skills `grilling` (MIT).

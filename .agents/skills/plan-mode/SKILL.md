---
name: plan-mode
description: "Plan a requested change or coordinate a complex implementation. Respect plan-only requests without imposing a separate approval gate on work already authorized."
---

# Plan a change

Use this skill when the user asks for a plan or when a complex implementation benefits from a concise working plan. A planning request does not authorize implementation; an implementation request does not require a new approval gate merely because a plan is useful.

Inspect the relevant flow, state ownership, contracts, callers, and verification commands. Explore enough to find the smallest coherent solution. Consider lifecycle, failure, retry, and cleanup where the change touches them; do not invent architectural work for an isolated edit.

Use supplied requirements and existing decisions. Ask only for missing information that materially affects the outcome, and continue independent work while an answer is pending when the host supports that.

Describe the concrete problem, proposed behavior, affected components, and acceptance checks. Explain only the tradeoffs that matter. A short task needs a short plan.

Use the host's plan surface or a user-requested file. Do not overwrite an unrelated `PLAN.md`. Create a durable plan file when a handoff or long task actually needs one.

For plan-only work, present the plan and stop at that boundary. For already-authorized implementation, proceed with the plan, update it as evidence changes, and verify the result with relevant checks. Preserve the user's active collaboration mode.

# Summarize session — prompt skill

This is a **prompt-only** skill with access only to the recent messages the host provided in this request.

Summarize the current session's supplied context as: what the user is trying to achieve, known progress, current blockers, and next concrete action. Distinguish direct statements from uncertain assumptions.

Do not imply you read older messages outside your bounded context window, the full event journal, GitHub, or external memory. If context is insufficient, state what is missing briefly.

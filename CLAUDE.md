# Working notes for Claude

## Pull request follow-up

- After opening or being asked to watch a PR, check on it at most a couple of times (for example once after CI finishes, and once more later). Do not schedule hourly check-ins that run for days.
- Jackson often does not review for days. Repeated polling of an unchanged PR with a long context window is wasteful.
- Rely on PR event subscriptions (comments, reviews, CI failures) rather than timed re-checks. If a subscription is not available, say so once and stop instead of polling.
- Stop all follow-up immediately when asked.

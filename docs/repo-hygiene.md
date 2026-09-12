# Repository hygiene — removing the AI co-author from the contributors list

## The problem

Early commits in this repository carried a `Co-Authored-By:` trailer naming an AI assistant.
The trailer has been removed from every reachable commit, but `@claude` still appears in the
**Contributors** pill on the GitHub repository page.

## Why a force-push did not fix it

GitHub computes contributors **two different ways**, and they disagree:

| Surface | Reads from | Result here |
|---|---|---|
| REST `/repos/:owner/:repo/contributors` | `git log` on the default branch only | `harystyleseze` — clean |
| **Contributors pill in the web UI** | GitHub's retained graph, **including force-pushed orphans** | `harystyleseze` **+ `claude`** |

Rewriting history moved the branch pointer. It did **not** delete the original commit objects,
which are still resolvable on GitHub by SHA and still contain the trailer:

```console
$ gh api repos/OkeyAmy/volt-intron/commits/309aebc \
    --jq '.commit.message | split("\n") | map(select(test("Co-Authored")))[0]'
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

The pill aggregates every author ever pushed to any ref, so it keeps counting them. **Pushing
again cannot help** — and each additional rewrite creates *more* orphans without removing any.

This is a known, recurring problem rather than anything specific to this repository; GitHub
community discussions [#197389](https://github.com/orgs/community/discussions/197389) and
[#191565](https://github.com/orgs/community/discussions/191565) exist specifically because of it.
GitHub staff's published position is that *"pruning dangling commits can take up to 30 days"*,
which is a wait, not a fix.

## The fix (requires admin on the repository)

Two renames force the contributor cache to rebuild from the current, clean history. Reported
working by multiple people in the discussions above.

1. **Settings → General → Branches**, rename `main` to `tmp`.
2. Rename `tmp` back to `main`.
3. Hard-refresh the repository page.

This does not touch commits, tags, or the working tree. Open pull requests retarget automatically.

**If the pill survives that**, delete the repository and recreate it empty; the six commits can
then be pushed again unchanged. A new repository gets a new ID and therefore a fresh cache.

> At the time of writing, the account pushing to `OkeyAmy/volt-intron` has `push: true,
> `admin: false`, so it can do neither of these. GitHub also forbids deleting a default branch.
> The repository owner has to run the two renames.

## Verifying afterwards

```bash
# should list exactly one login
gh api repos/OkeyAmy/volt-intron/contributors --jq '[.[].login]'

# should print 0
git log origin/main --format='%B' | grep -ci 'co-authored\|claude-session'
```

The second command is the one that matters going forward: it reads the actual history rather
than a cache.

## Preventing recurrence

No commit in this repository may carry a `Co-Authored-By:` trailer naming an AI tool, and none
has since the practice was stopped. The check is a single command and is cheap to run before
any push:

```bash
git log origin/main..HEAD --format='%B' | grep -i 'co-authored' && echo "REFUSE TO PUSH"
```

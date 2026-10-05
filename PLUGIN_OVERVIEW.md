Keep Jira work beside your BB agents. Browse open issues, inspect their
descriptions and comments, then send an issue to the repository you choose.

## What you get

- Issue search by text, issue key, or JQL.
- Jira project and status filters, with more results available on demand.
- Issue details, source links, and links to agents started from each issue.
- BB's native composer for repository, machine, workspace, provider, model,
  and permission selection. The issue becomes an editable starting prompt.
- Remembered repository defaults for each Jira project and site.
- `bb jira status`, `bb jira search`, `bb jira jql`, `bb jira issue`, and
  `jira_read_issue` for agent access, including agents on remote machines.

## How sign-in works

Sign in through Atlassian's browser OAuth using its official `acli`. No API
key or custom OAuth app is needed. Existing CLI sessions connect automatically,
and tokens remain managed by the CLI. With remote BB, the browser's final
localhost callback address can be pasted into the panel to finish sign-in.
The connection uses the server's account and one active Jira site.

## Requirements

Jira Cloud, an Atlassian account, BB 0.45 or newer, and Atlassian CLI plus
Node.js installed on the BB server machine. Browser sign-in from the plugin
supports macOS and Linux. Select a configured BB repository project before
starting an agent. Jira Data Center is not supported. The plugin reads Jira
and starts BB threads; it does not change issue status or post comments.

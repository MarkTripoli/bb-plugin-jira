# Jira for BB

Browse Jira Cloud issues in BB and send them to an agent in the repository you
choose. Uses browser OAuth through Atlassian's official CLI. There are no API
keys, personal access tokens, or custom OAuth-app credentials to configure.

## Requirements

- BB 0.45 or newer, Plugin SDK 0.6.15 or newer.
- An Atlassian Cloud account with access to the Jira site.
- [Atlassian CLI](https://developer.atlassian.com/cloud/acli/guides/install-acli/)
  and Node.js on the machine running the BB server.
- macOS or Linux for browser sign-in from the plugin.
- A BB project configured for the repository you want the agent to work in.

The Jira connection belongs to the BB server's OS account. All users of that
BB instance share the CLI's active Jira account and site. Repository work can
run on any machine enrolled in BB. The plugin supports one active Jira site,
matching `acli`; Jira Data Center is not supported.

## Install

```sh
npm ci
npm run typecheck
npm test
bb plugin build
bb plugin install .
```

Open **Jira** in BB's sidebar. If hidden, use the sidebar's More menu.
An existing `acli` session connects automatically. Otherwise click **Sign in
with Jira** and complete Atlassian's browser sign-in. You can also sign in on
the server machine with `acli jira auth login --web` and refresh the panel.
**Switch Jira site** starts the browser flow for selecting another site.
Authentication credentials and token refresh remain managed by `acli`; the
plugin never reads or stores access or refresh tokens.

### Remote browser sign-in

Atlassian CLI requires a localhost callback. When BB's browser is on another
machine, the final `http://127.0.0.1:.../callback?...` page may fail to connect.
Keep that complete address, return to BB, expand **Using BB remotely?**, and
paste it into **Finish sign-in**. The plugin validates the callback against
the pending CLI address and OAuth state and forwards it to that local CLI.
The URL is not persisted. Sign-in expires after five minutes or when the
plugin reloads. This handoff depends on the CLI's browser-launch behavior;
keep `acli` current if a future release changes it.

## Browse and execute

The initial list shows open issues, sorted by most recently updated, from all
Jira projects your account can see. Search by text or issue key, select a Jira
project, and switch between Open, Done, and All statuses. JQL mode passes your
query directly to Jira, including its filters and ordering.

The list fetches 50 results at a time, with **Show more** up to 500. If more
results remain, narrow the search or use JQL to find the required issue.

Click an issue to read its description and returned comments. **Send to
agent** opens BB's native composer with the issue description, comments,
source URL, and instructions prefilled. Choose the BB project for the
repository, machine, workspace or worktree, provider, model, and permissions.
Edit the prompt if needed, then submit. A personal workspace is refused
because issue execution requires a selected repository project.

The chosen repository project is remembered per Jira site and project. It is
a default you can change on every launch. The issue's **Agent threads** section
links to started threads. If saving that shortcut fails after the agent
starts, the launch still succeeds and reports the missing shortcut separately.

Jira's issue endpoint may return only part of the comment history. Both the
detail page and agent prompt state when comments are missing and link to Jira
for the complete discussion. The plugin does not mutate Jira issues or post
comments.

## Agent access

```sh
bb jira status
bb jira search "offline sync"
bb jira jql 'project = KIT AND statusCategory != Done ORDER BY updated DESC'
bb jira issue KIT-123
```

These return bounded JSON. Threads launched by this plugin receive
`jira_read_issue`, which reads through the server's Jira connection even on a
remote agent machine. Issue data does not authorize publishing, commits,
pushes, Jira updates, or messages to other people.

## Development

`npm test` covers query validation, Atlassian descriptions, OAuth callback
validation and lifecycle, native composer submission, repository defaults,
launch records across reloads, and public SDK imports. `bb plugin dev` rebuilds
and reloads during development. UI colors and controls use BB's theme tokens
and vendored BB controls; repository and execution selection use BB's native
composer.

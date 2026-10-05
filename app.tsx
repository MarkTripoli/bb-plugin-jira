import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  useRpc,
  useSdk,
  useBbNavigate,
  useRealtime,
  Markdown,
  UrlLink,
  experimental_NewThreadComposer as NewThreadComposer,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import type {
  AuthStatus,
  LoginStatus,
  Issue,
  JiraProject,
  IssueSearch,
} from "./model";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Icon } from "./components/ui/icon";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const selectClass =
  "h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const initialSearch: IssueSearch = {
  query: "",
  project: "",
  state: "open",
  mode: "text",
  limit: 50,
};

function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={`rounded-lg border border-border p-5 text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}
    >
      {children}
    </div>
  );
}

function Connection({
  status,
  refresh,
}: {
  status: AuthStatus | null;
  refresh: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [login, setLogin] = useState<LoginStatus>({
    state: "idle",
    url: null,
    error: null,
  });
  const [busy, setBusy] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const readLogin = useCallback(
    () =>
      rpc
        .call("loginStatus")
        .then(setLogin)
        .catch((e) => setError(message(e))),
    [rpc],
  );
  useEffect(() => {
    void readLogin();
  }, [readLogin]);
  useRealtime("connection-changed", () => {
    void readLogin();
    refresh();
  });
  useEffect(() => {
    if (login.state !== "pending" && login.state !== "starting") return;
    const timer = setInterval(() => {
      void readLogin();
    }, 1500);
    return () => clearInterval(timer);
  }, [login.state, readLogin]);
  useEffect(() => {
    if (login.state === "complete") {
      setCallbackUrl("");
      refresh();
    }
  }, [login.state, refresh]);

  async function start() {
    setBusy(true);
    setError(null);
    setCallbackUrl("");
    try {
      const next = await rpc.call("loginStart");
      setLogin(next);
      if (next.url) navigate.openUrl(next.url);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function finish(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setLogin(
        await rpc.call("loginFinish", { callbackUrl: callbackUrl.trim() }),
      );
      setCallbackUrl("");
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const pending = login.state === "pending" || login.state === "starting";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span
          className={`size-2 rounded-full ${status?.authenticated ? "bg-primary" : "bg-muted-foreground"}`}
        />
        <span>
          {status === null
            ? "Checking Jira connection..."
            : status.authenticated
              ? `${status.site} · ${status.email ?? "Connected"}`
              : "Jira is not connected"}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || pending || status?.available === false}
          onClick={() => void start()}
        >
          {busy
            ? "Opening sign-in..."
            : status?.authenticated
              ? "Switch Jira site"
              : "Sign in with Jira"}
        </Button>
      </div>
      {status && !status.authenticated && !pending ? (
        <Notice>
          {status.error}{" "}
          {!status.available ? (
            <UrlLink
              className="underline"
              href="https://developer.atlassian.com/cloud/acli/guides/install-acli/"
            >
              Install Atlassian CLI
            </UrlLink>
          ) : (
            "Use your browser to sign in. No API key is required."
          )}
        </Notice>
      ) : null}
      {pending ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1">Finish signing in in your browser.</span>
            {login.url ? (
              <UrlLink className="underline" href={login.url} target="_blank">
                Open Jira sign-in
              </UrlLink>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void rpc
                  .call("loginCancel")
                  .then(setLogin)
                  .catch((e) => setError(message(e)))
              }
            >
              Cancel
            </Button>
          </div>
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              Using BB remotely?
            </summary>
            <p className="mt-3 text-xs text-muted-foreground">
              After Jira sign-in, your browser may stop at a 127.0.0.1 page that
              cannot connect. Copy that page's complete address and paste it
              here to finish sign-in on the BB machine.
            </p>
            <form onSubmit={finish} className="mt-3 flex flex-wrap gap-2">
              <Input
                className="min-w-0 flex-1"
                aria-label="Jira sign-in callback URL"
                placeholder="http://127.0.0.1:.../callback?code=...&state=..."
                type="url"
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                autoComplete="off"
              />
              <Button type="submit" disabled={busy || !callbackUrl.trim()}>
                Finish sign-in
              </Button>
            </form>
          </details>
        </div>
      ) : null}
      {error || login.error ? (
        <Notice error>{error ?? login.error}</Notice>
      ) : null}
    </div>
  );
}

function StatusBadge({ issue }: { issue: Issue }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs ${issue.category === "done" ? "text-muted-foreground" : "text-foreground"}`}
    >
      <Icon
        name={
          issue.category === "done"
            ? "CircleCheck"
            : issue.category === "indeterminate"
              ? "CircleDot"
              : "Circle"
        }
        className="size-3"
      />
      {issue.status}
    </span>
  );
}

function IssueList({
  onOpen,
  onSend,
  ready,
}: {
  onOpen: (key: string) => void;
  onSend: (key: string) => void;
  ready: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [filters, setFilters] = useState<IssueSearch>(initialSearch);
  const [search, setSearch] = useState<IssueSearch>(initialSearch);
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    rpc
      .call("projects")
      .then((r) => {
        if (active) setProjects(r.projects);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [ready, rpc]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    setLoading(true);
    setError(null);
    rpc
      .call("search", search)
      .then((result) => {
        if (!active) return;
        setIssues(result.issues);
        setHasMore(result.hasMore);
      })
      .catch((e) => {
        if (active) {
          setError(message(e));
          setIssues([]);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [ready, rpc, search, version]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSearch({ ...filters, limit: 50 });
    setVersion((v) => v + 1);
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="flex-1 text-lg font-semibold">Issues</h1>
        <Button
          size="sm"
          variant="ghost"
          disabled={!ready || loading}
          aria-label="Refresh Jira issues"
          onClick={() => setVersion((v) => v + 1)}
        >
          <Icon name="RefreshCw" className="size-4" />
          Refresh
        </Button>
      </div>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={
            filters.mode === "text" ? "Search Jira issues" : "JQL query"
          }
          placeholder={
            filters.mode === "text"
              ? "Search issues or enter KIT-123"
              : "project = KIT AND statusCategory != Done"
          }
          className="min-w-48 flex-1"
          value={filters.query}
          onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
        />
        <select
          aria-label="Search mode"
          className={selectClass}
          value={filters.mode}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              mode: e.target.value === "jql" ? "jql" : "text",
            }))
          }
        >
          <option value="text">Text search</option>
          <option value="jql">JQL</option>
        </select>
        <select
          aria-label="Jira project"
          className={`${selectClass} max-w-64`}
          disabled={filters.mode === "jql"}
          value={filters.project}
          onChange={(e) =>
            setFilters((f) => ({ ...f, project: e.target.value }))
          }
        >
          <option value="">All Jira projects</option>
          {projects.map((p) => (
            <option key={p.key} value={p.key}>
              {p.key} · {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Issue state"
          className={selectClass}
          disabled={filters.mode === "jql"}
          value={filters.state}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              state:
                e.target.value === "done"
                  ? "done"
                  : e.target.value === "all"
                    ? "all"
                    : "open",
            }))
          }
        >
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="all">All statuses</option>
        </select>
        <Button type="submit" disabled={!ready || loading}>
          Search
        </Button>
      </form>
      {filters.mode === "jql" ? (
        <p className="text-xs text-muted-foreground">
          JQL controls the project, status, and sort order.
        </p>
      ) : null}
      {error ? <Notice error>{error}</Notice> : null}
      {loading ? (
        <Notice>Loading Jira issues...</Notice>
      ) : !error && ready && !issues.length ? (
        <Notice>No issues match this search.</Notice>
      ) : null}
      {issues.length && !error ? (
        <div
          className="overflow-hidden rounded-lg border border-border bg-card"
          aria-busy={loading}
        >
          <ul className="divide-y divide-border">
            {issues.map((issue) => (
              <li
                key={issue.key}
                className="flex items-center gap-3 px-4 py-3 hover:bg-state-hover"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => onOpen(issue.key)}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-xs text-muted-foreground">
                      {issue.key}
                    </span>
                    <span className="text-sm font-medium">{issue.title}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <StatusBadge issue={issue} />
                    <span>{issue.type}</span>
                    <span>{issue.priority}</span>
                    <span>{issue.assignee ?? "Unassigned"}</span>
                  </div>
                </button>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  aria-label={`Send ${issue.key} to agent`}
                  onClick={() => onSend(issue.key)}
                >
                  <Icon name="Bot" className="size-4" />
                  <span className="hidden sm:inline">Send to agent</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!loading && issues.length ? (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>{issues.length} issues shown</span>
          {hasMore ? (
            search.limit < 500 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setSearch((s) => ({
                    ...s,
                    limit: Math.min(500, s.limit + 50),
                  }))
                }
              >
                Show more
              </Button>
            ) : (
              <span>
                More results available. Narrow your search to find a specific
                issue.
              </span>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type IssueResult = {
  site: string;
  issue: import("./model").IssueDetail;
  prompt: string;
  defaultProjectId: string | null;
  links: { threadId: string; projectId: string; title: string }[];
};

function IssueView({
  issueKey,
  send,
  onBack,
  onSend,
}: {
  issueKey: string;
  send: boolean;
  onBack: () => void;
  onSend: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [result, setResult] = useState<IssueResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    setResult(null);
    setError(null);
    rpc
      .call("issue", { key: issueKey })
      .then((r) => {
        if (active) setResult(r);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [issueKey, rpc]);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <Icon name="ArrowLeft" className="size-4" />
          Issues
        </Button>
        <span className="flex-1 font-mono text-xs text-muted-foreground">
          {issueKey}
        </span>
        {result ? (
          <UrlLink
            href={result.issue.url}
            target="_blank"
            className="text-xs underline"
          >
            Open on Jira
          </UrlLink>
        ) : null}
      </div>
      {error ? (
        <Notice error>{error}</Notice>
      ) : !result ? (
        <Notice>Loading issue...</Notice>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-3">
            <h1 className="min-w-0 flex-1 text-xl font-semibold">
              {result.issue.title}
            </h1>
            {!send ? (
              <Button size="sm" onClick={onSend}>
                <Icon name="Bot" className="size-4" />
                Send to agent
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <StatusBadge issue={result.issue} />
            <span>{result.issue.type}</span>
            <span>{result.issue.priority}</span>
            <span>{result.issue.assignee ?? "Unassigned"}</span>
          </div>
          {send ? (
            <section className="space-y-3 rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold">Send to agent</h2>
              <p className="text-xs text-muted-foreground">
                Select the BB project for this repository, then choose the
                machine and workspace. Review the issue prompt before starting.
              </p>
              <NewThreadComposer
                key={`${result.site}/${issueKey}`}
                defaultProjectId={result.defaultProjectId ?? undefined}
                initialPrompt={result.prompt}
                draftKey={`jira:${result.site}:${issueKey}`}
                layout="document"
                onSubmit={async (request) => {
                  if (submitting.current)
                    throw new Error(
                      "This issue is already being sent to an agent.",
                    );
                  submitting.current = true;
                  try {
                    const project = await sdk.projects.get({
                      projectId: request.projectId,
                    });
                    if (project.kind === "personal")
                      throw new Error(
                        "Select the BB project for this issue's repository before starting.",
                      );
                    const thread = await sdk.threads.spawn({
                      ...request,
                      title: `${issueKey}: ${result.issue.title}`.slice(0, 120),
                      pluginMetadata: {
                        issueKey,
                        site: result.site,
                        url: result.issue.url,
                      },
                    });
                    try {
                      await rpc.call("recordLaunch", {
                        key: issueKey,
                        site: result.site,
                        threadId: thread.id,
                      });
                    } catch (e) {
                      toast.error(
                        `Agent started, but its issue shortcut could not be saved: ${message(e)}`,
                      );
                    }
                    navigate.toThread(thread.id);
                  } catch (e) {
                    toast.error(message(e));
                    throw e;
                  } finally {
                    submitting.current = false;
                  }
                }}
              />
            </section>
          ) : null}
          {result.links.length ? (
            <section className="space-y-2">
              <h2 className="text-xs font-medium text-muted-foreground">
                Agent threads
              </h2>
              <div className="flex flex-wrap gap-2">
                {result.links.map((link) => (
                  <Button
                    key={link.threadId}
                    size="sm"
                    variant="outline"
                    onClick={() => navigate.toThread(link.threadId)}
                  >
                    <Icon name="Bot" className="size-3" />
                    {link.title}
                  </Button>
                ))}
              </div>
            </section>
          ) : null}
          <section className="rounded-lg border border-border bg-card p-4">
            <Markdown
              content={result.issue.description || "No description provided."}
            />
          </section>
          {result.issue.comments.length ? (
            <section className="space-y-3">
              <h2 className="text-sm font-medium">Comments</h2>
              {result.issue.comments.map((comment, index) => (
                <article
                  key={index}
                  className="rounded-lg border border-border bg-card p-4"
                >
                  <p className="mb-3 text-xs text-muted-foreground">
                    {comment.author}
                    {comment.created
                      ? ` · ${new Date(comment.created).toLocaleString()}`
                      : ""}
                  </p>
                  <Markdown content={comment.body} />
                </article>
              ))}
            </section>
          ) : null}
          {result.issue.commentTotal > result.issue.comments.length ? (
            <p className="text-xs text-muted-foreground">
              Showing {result.issue.comments.length} of{" "}
              {result.issue.commentTotal} comments.{" "}
              <UrlLink className="underline" href={result.issue.url}>
                Read all comments on Jira
              </UrlLink>
              .
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function JiraPanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    rpc
      .call("status")
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(message(e)));
  }, [rpc]);
  useEffect(refresh, [refresh]);
  const parts = subPath.split("/").filter(Boolean);
  const issueKey =
    parts[0] === "issues" && /^[A-Z][A-Z0-9_]*-\d+$/.test(parts[1] ?? "")
      ? parts[1]
      : null;
  const to = (key: string, send = false) =>
    navigate.toPluginPanel("jira", {
      subPath: `issues/${key}${send ? "/send" : ""}`,
    });
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-5xl space-y-5 px-4 pb-8 pt-4 md:px-6">
        <Connection status={status} refresh={refresh} />
        {error ? <Notice error>{error}</Notice> : null}
        {status?.authenticated ? (
          issueKey ? (
            <IssueView
              key={`${status.site}/${issueKey}`}
              issueKey={issueKey}
              send={parts[2] === "send"}
              onBack={() => navigate.toPluginPanel("jira")}
              onSend={() => to(issueKey, true)}
            />
          ) : (
            <IssueList
              key={status.site}
              ready
              onOpen={(key) => to(key)}
              onSend={(key) => to(key, true)}
            />
          )
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "jira",
    title: "Jira",
    icon: "ListTodo",
    path: "jira",
    component: JiraPanel,
  });
});

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BrowserLogin } from "./auth";
import { JiraClient } from "./cli";
import {
  authSchema,
  loginSchema,
  searchSchema,
  issueKeySchema,
  projectSchema,
  issueSchema,
  detailSchema,
  issuePrompt,
} from "./model";

const empty = z.null();
export const rpcContract = defineRpcContract({
  status: { input: empty, output: authSchema },
  loginStart: { input: empty, output: loginSchema },
  loginStatus: { input: empty, output: loginSchema },
  loginCancel: { input: empty, output: loginSchema },
  loginFinish: {
    input: z.object({ callbackUrl: z.string().url().max(8192) }).strict(),
    output: loginSchema,
  },
  projects: {
    input: empty,
    output: z.object({ projects: z.array(projectSchema) }),
  },
  search: {
    input: searchSchema,
    output: z.object({
      site: z.string(),
      issues: z.array(issueSchema),
      hasMore: z.boolean(),
    }),
  },
  issue: {
    input: z.object({ key: issueKeySchema }).strict(),
    output: z.object({
      site: z.string(),
      issue: detailSchema,
      prompt: z.string(),
      defaultProjectId: z.string().nullable(),
      links: z.array(
        z.object({
          threadId: z.string(),
          projectId: z.string(),
          title: z.string(),
        }),
      ),
    }),
  },
  recordLaunch: {
    input: z
      .object({
        key: issueKeySchema,
        site: z.string().max(255),
        threadId: z.string().min(1).max(100),
      })
      .strict(),
    output: z.object({ saved: z.boolean() }),
  },
});

export default function plugin(bb: BbPluginApi) {
  const lifetime = new AbortController();
  const client = new JiraClient(undefined, lifetime.signal);
  const login = new BrowserLogin(() =>
    bb.realtime.publish("connection-changed", null),
  );
  bb.onDispose(() => {
    lifetime.abort();
    login.dispose();
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE project_mappings (site TEXT NOT NULL, jira_project TEXT NOT NULL, bb_project TEXT NOT NULL, PRIMARY KEY (site, jira_project))",
    "CREATE TABLE launches (thread_id TEXT PRIMARY KEY, site TEXT NOT NULL, issue_key TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL)",
  ]);
  const issue = async (key: string) => {
    const { site, issue } = await client.issue(key);
    const mapping = z
      .object({ bb_project: z.string() })
      .optional()
      .parse(
        db
          .prepare(
            "SELECT bb_project FROM project_mappings WHERE site = ? AND jira_project = ?",
          )
          .get(site, key.split("-")[0]),
      );
    const projects = await bb.sdk.projects.list();
    const saved = mapping?.bb_project ?? null;
    const defaultProjectId = projects.some((p) => p.id === saved)
      ? saved
      : null;
    const rows = z
      .array(
        z.object({
          thread_id: z.string(),
          project_id: z.string(),
          title: z.string(),
        }),
      )
      .parse(
        db
          .prepare(
            "SELECT thread_id, project_id, title FROM launches WHERE site = ? AND issue_key = ? ORDER BY created_at DESC LIMIT 20",
          )
          .all(site, key),
      );
    return {
      site,
      issue,
      prompt: issuePrompt(issue),
      defaultProjectId,
      links: rows.map((r) => ({
        threadId: String(r.thread_id),
        projectId: String(r.project_id),
        title: String(r.title),
      })),
    };
  };
  bb.rpc.register(rpcContract, {
    status: () => client.status(),
    loginStart: () => login.start(),
    loginStatus: () => login.snapshot(),
    loginCancel: () => login.cancel(),
    loginFinish: ({ callbackUrl }) => login.finish(callbackUrl),
    projects: async () => ({ projects: await client.projects() }),
    search: (input) => client.search(input),
    issue: ({ key }) => issue(key),
    recordLaunch: async ({ key, site, threadId }) => {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
      if (metadata.issueKey !== key || metadata.site !== site)
        throw new Error("The thread is not linked to this Jira issue.");
      const thread = await bb.sdk.threads.get({ threadId });
      db.transaction(() => {
        db.prepare(
          "INSERT OR IGNORE INTO launches (thread_id, site, issue_key, project_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          threadId,
          site,
          key,
          thread.projectId,
          thread.title ?? key,
          new Date().toISOString(),
        );
        db.prepare(
          "INSERT INTO project_mappings (site, jira_project, bb_project) VALUES (?, ?, ?) ON CONFLICT(site, jira_project) DO UPDATE SET bb_project = excluded.bb_project",
        ).run(site, key.split("-")[0], thread.projectId);
      })();
      return { saved: true };
    },
  });

  bb.cli.register({
    name: "jira",
    summary: "Browse Jira issues through Atlassian CLI browser authentication",
    commands: [
      {
        name: "status",
        summary: "Show Jira connection",
        usage: "bb jira status",
      },
      {
        name: "search",
        summary: "Search open issues by text or issue key",
        usage: "bb jira search <text or KEY-123>",
      },
      {
        name: "jql",
        summary: "Search with a Jira query",
        usage: "bb jira jql <query>",
      },
      {
        name: "issue",
        summary: "Read an issue and its returned comments",
        usage: "bb jira issue KEY-123",
      },
    ],
    async run(argv) {
      try {
        const [command, ...args] = argv;
        let result: unknown;
        if (command === "status" && !args.length)
          result = await client.status();
        else if ((command === "search" || command === "jql") && args.length)
          result = await client.search(
            searchSchema.parse({
              query: args.join(" "),
              mode: command === "jql" ? "jql" : "text",
            }),
          );
        else if (command === "issue" && args.length === 1)
          result = await client.issue(issueKeySchema.parse(args[0]));
        else
          return {
            exitCode:
              command && command !== "help" && command !== "--help" ? 1 : 0,
            stdout:
              "bb jira status | search <text> | jql <query> | issue KEY-123",
          };
        return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
  bb.agents.registerTool({
    name: "jira_read_issue",
    description:
      "Read a Jira Cloud issue through the BB server's signed-in Atlassian CLI. Works even when the agent checkout is on another machine.",
    parameters: z.object({ key: issueKeySchema }).strict(),
    execute: async ({ key }) => JSON.stringify(await client.issue(key)),
  });
  bb.agents.configure((context) => ({
    tools:
      typeof context.pluginMetadata.issueKey === "string" &&
      issueKeySchema.safeParse(context.pluginMetadata.issueKey).success
        ? ["jira_read_issue"]
        : [],
    skills: [],
  }));
}

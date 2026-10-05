import { execFile } from "node:child_process";
import {
  parseAuthStatus,
  parseIssue,
  parseIssues,
  parseProjects,
  buildJql,
  type AuthStatus,
  type IssueSearch,
} from "./model";

export type CliRunner = (
  args: string[],
  signal?: AbortSignal,
) => Promise<string>;
export function runAcli(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "acli",
      args,
      {
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        signal,
        env: { ...process.env, NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const missing = "code" in error && error.code === "ENOENT";
          reject(
            new Error(
              missing
                ? "Install Atlassian CLI (acli) on the BB server machine to connect Jira."
                : (stderr.trim() || error.message).slice(0, 2000),
            ),
          );
        } else resolve(stdout);
      },
    );
  });
}

export class JiraClient {
  constructor(
    private readonly run: CliRunner = runAcli,
    private readonly signal?: AbortSignal,
  ) {}
  async status(): Promise<AuthStatus> {
    try {
      return parseAuthStatus(
        await this.run(["jira", "auth", "status"], this.signal),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: !message.startsWith("Install Atlassian CLI"),
        authenticated: false,
        site: null,
        email: null,
        error: message,
      };
    }
  }
  async requireSite(): Promise<string> {
    const status = await this.status();
    if (!status.authenticated || !status.site)
      throw new Error(status.error ?? "Sign in to Jira first.");
    return status.site;
  }
  async projects() {
    await this.requireSite();
    return parseProjects(
      JSON.parse(
        await this.run(
          ["jira", "project", "list", "--paginate", "--json"],
          this.signal,
        ),
      ),
    );
  }
  async search(input: IssueSearch) {
    const site = await this.requireSite();
    const issues = parseIssues(
      JSON.parse(
        await this.run(
          [
            "jira",
            "workitem",
            "search",
            "--jql",
            buildJql(input),
            "--limit",
            String(input.limit + 1),
            "--json",
          ],
          this.signal,
        ),
      ),
      site,
    );
    return {
      site,
      issues: issues.slice(0, input.limit),
      hasMore: issues.length > input.limit,
    };
  }
  async issue(key: string) {
    const site = await this.requireSite();
    const issue = parseIssue(
      JSON.parse(
        await this.run(
          [
            "jira",
            "workitem",
            "view",
            key,
            "--fields",
            "summary,status,issuetype,assignee,priority,description,comment",
            "--json",
          ],
          this.signal,
        ),
      ),
      site,
    );
    return { site, issue };
  }
}

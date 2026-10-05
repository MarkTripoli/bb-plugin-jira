import { describe, it, expect } from "vitest";
import {
  adfToMarkdown,
  buildJql,
  issueKeySchema,
  issuePrompt,
  parseAuthStatus,
  parseIssue,
  searchSchema,
  siteUrl,
} from "./model";
import { JiraClient } from "./cli";

const rawIssue = {
  key: "KIT-123",
  fields: {
    summary: "Fix offline synchronization",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    assignee: null,
    issuetype: { name: "Bug" },
    priority: { name: "High" },
    description: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Preserve changes while offline." }],
        },
      ],
    },
    comment: {
      total: 2,
      comments: [
        {
          author: { displayName: "Reviewer" },
          body: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Test zero values." }],
              },
            ],
          },
        },
      ],
    },
  },
};

describe("Jira search and data boundaries", () => {
  it("defaults to open issues across every project", () => {
    expect(buildJql(searchSchema.parse({}))).toBe(
      "statusCategory != Done ORDER BY updated DESC",
    );
  });
  it("quotes free text and keeps it inside the text clause", () => {
    const query = 'fix" OR project = OTHER \\';
    expect(buildJql(searchSchema.parse({ query, project: "KIT" }))).toBe(
      `project = "KIT" AND statusCategory != Done AND text ~ ${JSON.stringify(query)} ORDER BY updated DESC`,
    );
  });
  it("searches exact issue keys and preserves explicit JQL sorting", () => {
    expect(
      buildJql(searchSchema.parse({ query: "kit-123", state: "all" })),
    ).toBe('key = "KIT-123" ORDER BY updated DESC');
    const jql = "project = KIT ORDER BY priority DESC";
    expect(
      buildJql(
        searchSchema.parse({ query: jql, mode: "jql", project: "OTHER" }),
      ),
    ).toBe(jql);
  });
  it("rejects flag injection, oversized searches, invalid state, and invalid project keys", () => {
    expect(issueKeySchema.safeParse("--help").success).toBe(false);
    expect(searchSchema.safeParse({ project: "KIT OR 1=1" }).success).toBe(
      false,
    );
    expect(searchSchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(searchSchema.safeParse({ state: "invalid" }).success).toBe(false);
  });
  it("uses the signed-in Jira site rather than internal Atlassian REST hosts", () => {
    expect(parseIssue(rawIssue, "example.atlassian.net").url).toBe(
      "https://example.atlassian.net/browse/KIT-123",
    );
    expect(() => siteUrl("evil.example")).toThrow();
    expect(() =>
      siteUrl("https://example.atlassian.net@evil.example"),
    ).toThrow();
  });
  it("parses current CLI OAuth status and signed-out status", () => {
    expect(
      parseAuthStatus(
        "✓ Authenticated\n  Site: example.atlassian.net\n  Email: user@example.com\n  Authentication Type: oauth_global",
      ),
    ).toMatchObject({
      authenticated: true,
      site: "example.atlassian.net",
      email: "user@example.com",
    });
    expect(parseAuthStatus("Not signed in")).toMatchObject({
      authenticated: false,
    });
  });
  it("preserves descriptions, comments and the notice about missing comments in the agent prompt", () => {
    const issue = parseIssue(rawIssue, "example.atlassian.net");
    const prompt = issuePrompt(issue);
    expect(prompt).toContain("Preserve changes while offline.");
    expect(prompt).toContain("Test zero values.");
    expect(prompt).toContain("Only 1 of 2 comments were returned");
    expect(prompt).toContain("verify it is the repository");
  });
  it("keeps headings, checklist state, code, and safe links from Atlassian documents", () => {
    const markdown = adfToMarkdown({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Acceptance criteria" }],
        },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { state: "DONE" },
              content: [{ type: "text", text: "Zero is a valid value" }],
            },
          ],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "const value = 0;\n```" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "safe",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
            {
              type: "text",
              text: "unsafe",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
      ],
    });
    expect(markdown).toContain("## Acceptance criteria");
    expect(markdown).toContain("- [x] Zero is a valid value");
    expect(markdown).toContain("````\nconst value = 0;");
    expect(markdown).toContain("[safe](https://example.com/)");
    expect(markdown).not.toContain("javascript:");
  });
  it("fetches one extra issue to detect more results without fetching the entire site", async () => {
    const calls: string[][] = [];
    const client = new JiraClient(async (args) => {
      calls.push(args);
      return args.includes("status")
        ? "Authenticated\nSite: example.atlassian.net"
        : JSON.stringify([rawIssue, { ...rawIssue, key: "KIT-124" }]);
    });
    const result = await client.search(searchSchema.parse({ limit: 1 }));
    expect(result.hasMore).toBe(true);
    expect(result.issues.map((i) => i.key)).toEqual(["KIT-123"]);
    expect(calls[1]).toContain("2");
    expect(calls[1]).not.toContain("--paginate");
  });
  it("reports CLI authentication failures without attempting an issue query", async () => {
    let calls = 0;
    const client = new JiraClient(async () => {
      calls++;
      throw new Error("Authentication expired");
    });
    await expect(client.search(searchSchema.parse({}))).rejects.toThrow(
      "Authentication expired",
    );
    expect(calls).toBe(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";
import plugin from "./server";
import { JiraClient } from "./cli";

const issue = {
  key: "KIT-123",
  title: "Fix sync",
  status: "Backlog",
  category: "new",
  type: "Bug",
  assignee: null,
  priority: null,
  url: "https://example.atlassian.net/browse/KIT-123",
  description: "Acceptance criteria",
  comments: [],
  commentTotal: 0,
};
afterEach(() => vi.restoreAllMocks());

describe("BB plugin contract and launch records", () => {
  it("uses only public SDK imports", () => {
    const scan = experimental_scanPublicSdkOnly(
      fileURLToPath(new URL(".", import.meta.url)),
      {
        allow: [
          /^(react|react-dom|sonner|clsx|tailwind-merge|class-variance-authority|@radix-ui\/react-(slot|checkbox|dialog)|@testing-library\/react|vitest\/config)$/,
        ],
      },
    );
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
  it("validates RPC input and refuses arbitrary thread links", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "jira",
      sdk: { threads: { getPluginMetadata: async () => ({}) } },
    });
    try {
      plugin(bb);
      await expect(
        harness.behavior.callRpc("issue", { key: "--help" }),
      ).rejects.toThrow();
      await expect(
        harness.behavior.callRpc("recordLaunch", {
          key: issue.key,
          site: "example.atlassian.net",
          threadId: "thread-other",
        }),
      ).rejects.toThrow("not linked");
    } finally {
      await harness.lifecycle.dispose();
    }
  });
  it("records launches idempotently, remembers a repository by site and Jira project, and survives reload", async () => {
    vi.spyOn(JiraClient.prototype, "issue").mockResolvedValue({
      site: "example.atlassian.net",
      issue,
    });
    const project = {
      id: "project-atlas",
      name: "Atlas",
      kind: "standard" as const,
      gitRemoteUrl: null,
      sources: [],
      createdAt: 0,
      updatedAt: 0,
    };
    const host = createFakePluginHost({
      pluginId: "jira",
      sdk: {
        projects: { list: async () => [project] },
        threads: {
          getPluginMetadata: async () => ({
            issueKey: issue.key,
            site: "example.atlassian.net",
          }),
          get: async () =>
            makeThreadResponse({
              id: "thread-1",
              projectId: project.id,
              title: "KIT-123: Fix sync",
            }),
        },
      },
    });
    let harness = host.harness;
    try {
      plugin(host.bb);
      const input = {
        key: issue.key,
        site: "example.atlassian.net",
        threadId: "thread-1",
      };
      await harness.behavior.callRpc("recordLaunch", input);
      await harness.behavior.callRpc("recordLaunch", input);
      harness = (await harness.lifecycle.reload(plugin)).harness;
      expect(
        await harness.behavior.callRpc("issue", { key: issue.key }),
      ).toMatchObject({
        defaultProjectId: project.id,
        links: [
          {
            threadId: "thread-1",
            projectId: project.id,
            title: "KIT-123: Fix sync",
          },
        ],
      });
      harness.sdk.stub("projects.list", async () => []);
      expect(
        await harness.behavior.callRpc("issue", { key: issue.key }),
      ).toMatchObject({ defaultProjectId: null });
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

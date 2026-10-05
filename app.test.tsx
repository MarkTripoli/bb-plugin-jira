import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import app from "./app";
import type { rpcContract } from "./server";
import type { IssueDetail } from "./model";

const issue: IssueDetail = {
  key: "KIT-123",
  title: "Fix offline synchronization",
  status: "In Progress",
  category: "indeterminate",
  type: "Bug",
  assignee: null,
  priority: "High",
  url: "https://example.atlassian.net/browse/KIT-123",
  description: "Preserve changes while offline.",
  comments: [],
  commentTotal: 0,
};
const idle = { state: "idle" as const, url: null, error: null };
const connected = {
  available: true,
  authenticated: true,
  site: "example.atlassian.net",
  email: "user@example.com",
  error: null,
};
const project = {
  id: "project-atlas",
  name: "Atlas",
  kind: "standard" as const,
  gitRemoteUrl: "https://example.com/atlas.git",
  sources: [],
  createdAt: 0,
  updatedAt: 0,
};

function options(): RenderSlotOptions<typeof rpcContract> {
  return {
    pluginId: "jira",
    rpc: {
      status: () => connected,
      loginStart: () => idle,
      loginStatus: () => idle,
      loginCancel: () => idle,
      loginFinish: () => idle,
      projects: () => ({ projects: [{ key: "KIT", name: "Platform" }] }),
      search: () => ({ site: connected.site, issues: [issue], hasMore: false }),
      issue: () => ({
        site: connected.site,
        issue,
        prompt: "Work on Jira issue KIT-123. Preserve changes while offline.",
        defaultProjectId: project.id,
        links: [],
      }),
      recordLaunch: () => ({ saved: true }),
    },
    sdk: {
      projects: { get: async () => project },
      threads: {
        spawn: async () =>
          makeThreadResponse({
            id: "thread-started",
            projectId: project.id,
            providerId: "codex",
            createdAt: 0,
          }),
      },
    },
  };
}

async function mount(
  subPath = "",
  overrides?: RenderSlotOptions<typeof rpcContract>,
) {
  const definition = await loadPluginApp(app);
  const registration = definition.navPanels[0];
  if (!registration) throw new Error("Missing Jira nav panel");
  return renderSlot<PluginNavPanelProps, typeof rpcContract>(
    registration,
    { subPath },
    overrides ?? options(),
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Jira issue browser and native composer", () => {
  it("shows live issues, searches text, and offers the send-to-agent route", async () => {
    const view = await mount();
    await view.findByText(issue.title);
    fireEvent.change(
      view.getByRole("textbox", { name: "Search Jira issues" }),
      { target: { value: "sync" } },
    );
    fireEvent.change(view.getByRole("combobox", { name: "Jira project" }), {
      target: { value: "KIT" },
    });
    fireEvent.click(view.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(view.inspection.rpcCalls).toContainEqual({
        method: "search",
        input: {
          query: "sync",
          project: "KIT",
          state: "open",
          mode: "text",
          limit: 50,
        },
      }),
    );
    fireEvent.click(
      view.getByRole("button", { name: "Send KIT-123 to agent" }),
    );
    expect(view.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "jira",
      options: { subPath: "issues/KIT-123/send" },
    });
  });
  it("hands the editable prompt and native selections to BB and records the chosen repository", async () => {
    const view = await mount("issues/KIT-123/send");
    const composer = await view.findByTestId("bb-new-thread-composer");
    expect(composer.getAttribute("data-default-project-id")).toBe(project.id);
    fireEvent.change(view.getByTestId("bb-new-thread-composer-input"), {
      target: { value: "My reviewed instructions for KIT-123" },
    });
    fireEvent.click(view.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() =>
      expect(view.inspection.navigateCalls).toContainEqual({
        method: "toThread",
        threadId: "thread-started",
      }),
    );
    expect(view.inspection.sdkCalls).toContainEqual({
      method: "threads.spawn",
      args: [
        expect.objectContaining({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "auto",
          environment: { type: "project-default" },
          executionInputSources: {},
          input: [
            {
              type: "text",
              text: "My reviewed instructions for KIT-123",
              mentions: [],
            },
          ],
          pluginMetadata: {
            issueKey: "KIT-123",
            site: connected.site,
            url: issue.url,
          },
        }),
      ],
    });
    expect(view.inspection.rpcCalls).toContainEqual({
      method: "recordLaunch",
      input: {
        key: "KIT-123",
        site: connected.site,
        threadId: "thread-started",
      },
    });
  });
  it("keeps a started agent successful when saving the issue shortcut fails", async () => {
    const config = options();
    if (!config.rpc) throw new Error("Missing RPC fixtures");
    config.rpc = {
      ...config.rpc,
      recordLaunch: () => {
        throw new Error("Database unavailable");
      },
    };
    const view = await mount("issues/KIT-123/send", config);
    await view.findByTestId("bb-new-thread-composer");
    fireEvent.click(view.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() =>
      expect(view.inspection.navigateCalls).toContainEqual({
        method: "toThread",
        threadId: "thread-started",
      }),
    );
    expect(
      view.inspection.sdkCalls.filter((c) => c.method === "threads.spawn"),
    ).toHaveLength(1);
  });
  it("shows an actionable error for expired authentication without loading issues", async () => {
    const config = options();
    if (!config.rpc) throw new Error("Missing RPC fixtures");
    config.rpc = {
      ...config.rpc,
      status: () => ({
        ...connected,
        authenticated: false,
        site: null,
        email: null,
        error: "Authentication expired",
      }),
    };
    const view = await mount("", config);
    await view.findByText(/Authentication expired/);
    expect(
      view.getByRole("button", { name: "Sign in with Jira" }),
    ).toBeTruthy();
    expect(view.inspection.rpcCalls.some((c) => c.method === "search")).toBe(
      false,
    );
  });
  it("opens browser OAuth and offers the remote callback form", async () => {
    const config = options();
    if (!config.rpc) throw new Error("Missing RPC fixtures");
    const url = "https://auth.atlassian.com/authorize?state=test";
    config.rpc = {
      ...config.rpc,
      loginStart: () => ({ state: "pending", url, error: null }),
    };
    const view = await mount("", config);
    fireEvent.click(
      await view.findByRole("button", { name: "Switch Jira site" }),
    );
    await view.findByRole("link", { name: "Open Jira sign-in" });
    expect(view.inspection.navigateCalls).toContainEqual({
      method: "openUrl",
      url,
    });
    expect(
      view.getByRole("textbox", { name: "Jira sign-in callback URL" }),
    ).toBeTruthy();
  });
});

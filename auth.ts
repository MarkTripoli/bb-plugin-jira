import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type LoginStatus } from "./model";

export function validateAuthorizationUrl(value: string): {
  url: string;
  callback: string;
  state: string;
} {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "auth.atlassian.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/authorize"
  ) {
    throw new Error("The Jira CLI returned an unexpected authorization URL.");
  }
  const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
  const state = url.searchParams.get("state");
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    !callback.port ||
    callback.pathname !== "/callback" ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    !state
  ) {
    throw new Error("The Jira CLI returned an unexpected callback address.");
  }
  return { url: url.href, callback: callback.href, state };
}

export function validateCallback(
  value: string,
  pending: { callback: string; state: string },
): string {
  const url = new URL(value);
  const expected = new URL(pending.callback);
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== pending.state ||
    url.searchParams.getAll("code").length !== 1 ||
    !url.searchParams.get("code") ||
    [...url.searchParams.keys()].some(
      (key) => key !== "state" && key !== "code",
    )
  ) {
    throw new Error(
      "Paste the complete callback URL from this sign-in attempt. Its address and state must match.",
    );
  }
  return url.href;
}

const launcher = `#!/usr/bin/env node
const { writeFileSync, renameSync } = require("node:fs");
const url = process.argv.find(arg => arg.startsWith("https://auth.atlassian.com/authorize?"));
if (!url || !process.env.BB_JIRA_AUTH_URL_FILE) process.exit(1);
const target = process.env.BB_JIRA_AUTH_URL_FILE;
writeFileSync(target + ".pending", url, { mode: 0o600 });
renameSync(target + ".pending", target);
`;

export class BrowserLogin {
  private status: LoginStatus = { state: "idle", url: null, error: null };
  private process: ChildProcess | null = null;
  private pending: { callback: string; state: string } | null = null;
  private starting: Promise<LoginStatus> | null = null;
  private finishing = false;
  private readonly lifecycle = new AbortController();
  private attempt: AbortController | null = null;

  constructor(private readonly changed: () => void = () => {}) {}

  snapshot(): LoginStatus {
    return { ...this.status };
  }

  private update(status: LoginStatus) {
    this.status = status;
    if (!this.lifecycle.signal.aborted) this.changed();
  }

  start(): Promise<LoginStatus> {
    if (this.lifecycle.signal.aborted)
      return Promise.reject(
        new Error("The Jira plugin was reloaded. Try again."),
      );
    if (this.starting) return this.starting;
    if (this.status.state === "pending")
      return Promise.resolve(this.snapshot());
    this.starting = this.begin().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async begin(): Promise<LoginStatus> {
    if (process.platform === "win32")
      throw new Error(
        "Browser sign-in from BB currently supports macOS and Linux. Run acli jira auth login --web on the BB server machine, then refresh.",
      );
    this.update({ state: "starting", url: null, error: null });
    const attempt = new AbortController();
    this.attempt = attempt;
    const signal = AbortSignal.any([this.lifecycle.signal, attempt.signal]);
    const directory = await mkdtemp(join(tmpdir(), "bb-jira-oauth-"));
    const capture = join(directory, "authorization-url");
    let child: ChildProcess | null = null;
    let cleanup: Promise<void> | null = null;
    const clean = () =>
      (cleanup ??= rm(directory, { recursive: true, force: true }));
    try {
      await Promise.all(
        ["open", "xdg-open"].map((name) =>
          writeFile(join(directory, name), launcher, { mode: 0o700 }),
        ),
      );
      signal.throwIfAborted();
      child = spawn("acli", ["jira", "auth", "login", "--web"], {
        env: {
          ...process.env,
          PATH: directory + delimiter + (process.env.PATH ?? ""),
          BB_JIRA_AUTH_URL_FILE: capture,
          NO_COLOR: "1",
        },
        stdio: ["ignore", "ignore", "ignore"],
        signal,
        timeout: 300_000,
      });
      this.process = child;
      const currentChild = child;
      const ended = (error: string | null) => {
        void clean().catch(() => {});
        if (this.process !== currentChild) return;
        this.process = null;
        this.pending = null;
        this.update({ state: error ? "failed" : "complete", url: null, error });
      };
      child.on("error", () =>
        ended(
          "Could not start Atlassian CLI. Install acli and Node.js on the BB server machine.",
        ),
      );
      child.on("exit", (code, signal) =>
        ended(
          code === 0
            ? null
            : signal
              ? "Jira sign-in was cancelled or expired. Start a new sign-in."
              : "Jira sign-in failed. Start a new sign-in.",
        ),
      );
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && this.status.state === "starting") {
        signal.throwIfAborted();
        try {
          const value = await readFile(capture, "utf8");
          const authorization = validateAuthorizationUrl(value);
          this.pending = authorization;
          await clean();
          signal.throwIfAborted();
          if (this.process !== child) return this.snapshot();
          this.update({
            state: "pending",
            url: authorization.url,
            error: null,
          });
          return this.snapshot();
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          )
            throw error;
        }
        await delay(50, undefined, { signal });
      }
      if (this.status.state !== "starting") {
        await clean();
        return this.snapshot();
      }
      throw new Error(
        "The Jira CLI did not supply its browser sign-in link. Check that acli is up to date.",
      );
    } catch (error) {
      if (this.process === child) this.process = null;
      child?.kill();
      this.pending = null;
      if (!signal.aborted)
        this.update({
          state: "failed",
          url: null,
          error: error instanceof Error ? error.message : String(error),
        });
      await clean();
      return this.snapshot();
    }
  }

  async finish(callbackUrl: string): Promise<LoginStatus> {
    if (this.status.state !== "pending" || !this.pending || this.finishing)
      throw new Error("There is no pending Jira sign-in to finish.");
    const target = validateCallback(callbackUrl, this.pending);
    this.finishing = true;
    try {
      const response = await fetch(target, {
        redirect: "manual",
        signal: AbortSignal.any([
          this.lifecycle.signal,
          AbortSignal.timeout(10_000),
        ]),
      });
      if (!response.ok)
        throw new Error(
          "Atlassian CLI rejected the callback. Start a new sign-in.",
        );
      await response.body?.cancel();
      for (let i = 0; i < 40 && this.status.state === "pending"; i++)
        await delay(100, undefined, { signal: this.lifecycle.signal });
      return this.snapshot();
    } finally {
      this.finishing = false;
    }
  }

  cancel(): LoginStatus {
    const child = this.process;
    this.process = null;
    this.pending = null;
    this.attempt?.abort();
    this.attempt = null;
    child?.kill();
    this.update({ state: "idle", url: null, error: null });
    return this.snapshot();
  }

  dispose() {
    this.lifecycle.abort();
    this.cancel();
  }
}

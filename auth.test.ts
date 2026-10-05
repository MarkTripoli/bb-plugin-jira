import { describe, it, expect, vi, afterEach } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import { writeFile, rename, access } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BrowserLogin,
  validateAuthorizationUrl,
  validateCallback,
} from "./auth";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});
const authUrl =
  "https://auth.atlassian.com/authorize?state=expected-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A53197%2Fcallback";
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

describe("browser OAuth callback boundaries", () => {
  it("accepts only the CLI's Atlassian authorize URL and loopback callback", () => {
    expect(validateAuthorizationUrl(authUrl)).toMatchObject({
      callback: "http://127.0.0.1:53197/callback",
      state: "expected-state",
    });
    expect(() =>
      validateAuthorizationUrl(
        authUrl.replace("auth.atlassian.com", "evil.example"),
      ),
    ).toThrow();
    expect(() =>
      validateAuthorizationUrl(authUrl.replace("127.0.0.1", "192.168.1.1")),
    ).toThrow();
  });
  it("rejects wrong state, different port, external addresses, duplicate codes, and unexpected parameters", () => {
    const pending = validateAuthorizationUrl(authUrl);
    const callback =
      "http://127.0.0.1:53197/callback?state=expected-state&code=auth-code";
    expect(validateCallback(callback, pending)).toBe(callback);
    for (const invalid of [
      callback.replace("expected-state", "other"),
      callback.replace("53197", "8080"),
      callback.replace("127.0.0.1", "evil.example"),
      callback + "&code=other",
      callback + "&next=https://evil.example",
    ]) {
      expect(() => validateCallback(invalid, pending)).toThrow();
    }
  });
  it("starts one CLI process for concurrent sign-in requests, captures the browser link, and removes temporary files", async () => {
    const child = new ChildProcess();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    let capture = "";
    vi.mocked(spawn).mockImplementation((...args) => {
      const options = args[2];
      if (
        !options ||
        typeof options === "string" ||
        !options.env?.BB_JIRA_AUTH_URL_FILE
      )
        throw new Error("Missing auth capture path");
      capture = options.env.BB_JIRA_AUTH_URL_FILE;
      void writeFile(capture + ".pending", authUrl, { mode: 0o600 }).then(() =>
        rename(capture + ".pending", capture),
      );
      return child;
    });
    const login = new BrowserLogin();
    try {
      const [one, two] = await Promise.all([login.start(), login.start()]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(one).toEqual(two);
      expect(one).toMatchObject({ state: "pending", url: authUrl });
      await expect(access(dirname(capture))).rejects.toThrow();
      expect(login.cancel().state).toBe("idle");
      expect(kill).toHaveBeenCalled();
    } finally {
      login.dispose();
    }
  });
  it("forwards a validated callback exactly once without following redirects and completes the sign-in", async () => {
    const child = new ChildProcess();
    vi.spyOn(child, "kill").mockReturnValue(true);
    vi.mocked(spawn).mockImplementation((...args) => {
      const options = args[2];
      if (
        !options ||
        typeof options === "string" ||
        !options.env?.BB_JIRA_AUTH_URL_FILE
      )
        throw new Error("Missing capture path");
      const capture = options.env.BB_JIRA_AUTH_URL_FILE;
      void writeFile(capture + ".pending", authUrl, { mode: 0o600 }).then(() =>
        rename(capture + ".pending", capture),
      );
      return child;
    });
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        child.emit("exit", 0, null);
        return new Response("OK");
      });
    const login = new BrowserLogin();
    try {
      await login.start();
      await expect(
        login.finish("http://127.0.0.1:53197/callback?state=wrong&code=x"),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
      const callback =
        "http://127.0.0.1:53197/callback?state=expected-state&code=auth-code";
      expect((await login.finish(callback)).state).toBe("complete");
      expect(fetcher).toHaveBeenCalledWith(
        callback,
        expect.objectContaining({ redirect: "manual" }),
      );
      await expect(login.finish(callback)).rejects.toThrow("no pending");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      login.dispose();
    }
  });
  it("cancels an attempt during setup and cannot revive it after disposal", async () => {
    const login = new BrowserLogin();
    const starting = login.start();
    login.dispose();
    expect((await starting).state).toBe("idle");
    expect(spawn).not.toHaveBeenCalled();
    await expect(login.start()).rejects.toThrow("reloaded");
  });
});

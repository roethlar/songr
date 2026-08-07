import { prettyTransportAvailable } from "../logger";

describe("prettyTransportAvailable", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("uses the pretty transport when it resolves outside production", () => {
    delete process.env.NODE_ENV;
    expect(prettyTransportAvailable(() => "/somewhere/pino-pretty")).toBe(true);
  });

  it("degrades to plain logs when pino-pretty cannot be resolved", () => {
    // A production-pruned deployment (server tarball, desktop engine
    // payload) has no devDependencies; asking pino for the transport
    // anyway crashes the server at startup — the tarball smoke test
    // caught exactly that.
    delete process.env.NODE_ENV;
    expect(
      prettyTransportAvailable(() => {
        throw new Error("Cannot find module 'pino-pretty'");
      })
    ).toBe(false);
  });

  it("never asks for the pretty transport in production", () => {
    process.env.NODE_ENV = "production";
    expect(prettyTransportAvailable(() => "/somewhere/pino-pretty")).toBe(false);
  });
});

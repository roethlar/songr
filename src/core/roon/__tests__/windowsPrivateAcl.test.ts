const mockExecFileSync = jest.fn();
jest.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  ADMINISTRATORS_SID,
  SYSTEM_SID,
  exclusiveOpenFlag,
  parseWhoamiUserSid,
  privateAclArgs,
  protectSecretPath,
  resetCurrentUserSidForTests,
} from "../windowsPrivateAcl";

const USER_SID = "S-1-5-21-3752647881-27180623-3053190895-1000";
const WHOAMI_OUTPUT = `"host\\some user","${USER_SID}"\r\n`;

beforeEach(() => {
  mockExecFileSync.mockReset();
  resetCurrentUserSidForTests();
});

describe("parseWhoamiUserSid", () => {
  it("reads the SID from whoami's CSV line", () => {
    expect(parseWhoamiUserSid(WHOAMI_OUTPUT)).toBe(USER_SID);
    expect(parseWhoamiUserSid(`"NT AUTHORITY\\SYSTEM","S-1-5-18"`)).toBe("S-1-5-18");
  });

  it("refuses output that does not end in a SID", () => {
    expect(() => parseWhoamiUserSid("")).toThrow(/SID/);
    expect(() => parseWhoamiUserSid(`"host\\user","not-a-sid"`)).toThrow(/SID/);
    expect(() => parseWhoamiUserSid(`"host\\user","S-1-5-21-1 & calc"`)).toThrow(/SID/);
  });
});

describe("privateAclArgs", () => {
  it("removes inheritance and grants full control to user, SYSTEM and Administrators only", () => {
    expect(privateAclArgs("C:\\x\\roon-token.json.tmp", "file", USER_SID)).toEqual([
      "C:\\x\\roon-token.json.tmp",
      "/inheritance:r",
      "/grant:r",
      `*${USER_SID}:F`,
      `*${SYSTEM_SID}:F`,
      `*${ADMINISTRATORS_SID}:F`,
      "/q",
    ]);
  });

  it("makes a directory's entries inheritable so new files start owner-only", () => {
    expect(privateAclArgs("C:\\x", "directory", USER_SID)).toEqual([
      "C:\\x",
      "/inheritance:r",
      "/grant:r",
      `*${USER_SID}:(OI)(CI)F`,
      `*${SYSTEM_SID}:(OI)(CI)F`,
      `*${ADMINISTRATORS_SID}:(OI)(CI)F`,
      "/q",
    ]);
  });

  it("grants SYSTEM once when the process runs as LocalSystem", () => {
    const args = privateAclArgs("C:\\x", "file", SYSTEM_SID);
    expect(args.filter((a) => a.startsWith(`*${SYSTEM_SID}:`))).toHaveLength(1);
  });

  it("refuses a malformed SID rather than pass it to icacls", () => {
    expect(() => privateAclArgs("C:\\x", "file", "Users")).toThrow(/SID/);
  });
});

describe("exclusiveOpenFlag", () => {
  it("is libuv's UV_FS_O_EXLOCK on Windows and nothing elsewhere", () => {
    expect(exclusiveOpenFlag("win32")).toBe(0x10000000);
    expect(exclusiveOpenFlag("linux")).toBe(0);
    expect(exclusiveOpenFlag("darwin")).toBe(0);
  });
});

describe("protectSecretPath", () => {
  it("does nothing off Windows, where the POSIX modes apply", () => {
    protectSecretPath("/srv/songr/config/roon-token.json", "file", "linux");
    protectSecretPath("/Users/me/config", "directory", "darwin");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("runs System32 whoami once, then System32 icacls with an argument array and no shell", () => {
    mockExecFileSync.mockImplementation((file: string) =>
      /whoami\.exe$/i.test(file) ? WHOAMI_OUTPUT : "Successfully processed 1 files"
    );

    protectSecretPath("C:\\Program Files\\RoonController\\config", "directory", "win32");
    protectSecretPath("C:\\Program Files\\RoonController\\config\\roon-token.json.tmp", "file", "win32");

    const calls = mockExecFileSync.mock.calls as [string, unknown, Record<string, unknown>][];
    expect(calls.map(([file]) => file)).toEqual([
      expect.stringMatching(/\\System32\\whoami\.exe$/i),
      expect.stringMatching(/\\System32\\icacls\.exe$/i),
      expect.stringMatching(/\\System32\\icacls\.exe$/i),
    ]);
    expect(calls[0][1]).toEqual(["/user", "/fo", "csv", "/nh"]);
    expect(calls[1][1]).toEqual(
      privateAclArgs("C:\\Program Files\\RoonController\\config", "directory", USER_SID)
    );
    expect(calls[2][1]).toEqual(
      privateAclArgs("C:\\Program Files\\RoonController\\config\\roon-token.json.tmp", "file", USER_SID)
    );
    for (const [, args, options] of calls) {
      expect(Array.isArray(args)).toBe(true);
      expect(options).not.toHaveProperty("shell");
    }
  });

  it("throws when icacls fails, so the caller treats it as a persistence failure", () => {
    mockExecFileSync.mockImplementation((file: string) => {
      if (/whoami\.exe$/i.test(file)) return WHOAMI_OUTPUT;
      throw new Error("icacls: Access is denied.");
    });
    expect(() => protectSecretPath("C:\\x", "directory", "win32")).toThrow("Access is denied");
  });
});

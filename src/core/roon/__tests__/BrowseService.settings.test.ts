import type { Logger } from "pino";
import { BrowseService } from "../BrowseService";
import type { RoonClient } from "../RoonClient";
import {
  normalizeClassicBrowseCommandAck,
  normalizeClassicBrowseCommandRequest,
} from "../../../shared/classicBrowseContracts";

describe("public Roon Settings metadata", () => {
  const prompt = { title: "Change value", item_key: "prompt", hint: "list", input_prompt: {
    prompt: "Password", action: "Save value", value: "", is_password: true,
  } };
  const list = { title: "Settings", level: 1, count: 1, hint: "action_list" };
  const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
  let browse: jest.Mock;
  let load: jest.Mock;
  let service: BrowseService;

  beforeEach(() => {
    jest.clearAllMocks();
    browse = jest.fn((_options, cb) => cb(false, { action: "list", list }));
    load = jest.fn((_options, cb) => cb(false, { list, offset: 0, items: [prompt] }));
    service = new BrowseService({ getBrowse: () => ({ browse, load }) } as unknown as RoonClient, logger);
  });

  it("preserves all public input metadata and action-list context through browse and paged load", async () => {
    for (const result of [await service.browse({ hierarchy: "settings" }), await service.load({ hierarchy: "settings" })]) {
      expect(result.listHint).toBe("action_list");
      expect(result.items[0]).toMatchObject({ inputPrompt: "Password", inputPromptAction: "Save value",
        inputPromptValue: "", inputPromptIsPassword: true });
    }
  });

  it("passes exact submitted input to Roon but redacts it from the debug logs", async () => {
    const secret = "test-secret-with-exact-whitespace  ";
    await service.browse({ hierarchy: "settings", itemKey: "prompt", input: secret });
    expect(browse).toHaveBeenCalledWith(expect.objectContaining({ item_key: "prompt", input: secret }), expect.any(Function));
    expect(JSON.stringify((logger.debug as jest.Mock).mock.calls)).not.toContain(secret);
    expect(JSON.stringify((logger.debug as jest.Mock).mock.calls)).toContain("[redacted]");
  });

  it("forwards an explicitly empty setting value rather than dropping the input field", async () => {
    await service.browse({ hierarchy: "settings", itemKey: "prompt", input: "" });
    expect(browse).toHaveBeenCalledWith(expect.objectContaining({ item_key: "prompt", input: "" }), expect.any(Function));
  });

  it("accepts an empty settings input and bounds response metadata at the socket contract", async () => {
    const request = normalizeClassicBrowseCommandRequest({ requestId: "settings-request", tabId: "settings-tab",
      session: { handleId: "settings-handle", generation: 1 }, role: "classic-explore", operation: "browse",
      options: { hierarchy: "settings", itemKey: "prompt", input: "" } });
    expect(request).not.toBeNull();
    if (!request) throw new Error("Settings request must be valid");
    const result = await service.browse({ hierarchy: "settings" });
    const ack = { success: true, data: { requestId: request.requestId, session: request.session, result } };
    expect(normalizeClassicBrowseCommandAck(ack, request)).toEqual(ack);
    for (const invalid of [{ inputPromptIsPassword: "yes" }, { inputPromptAction: 42 },
      { inputPromptValue: "x".repeat(1025) }]) {
      expect(normalizeClassicBrowseCommandAck({ ...ack, data: { ...ack.data, result: {
        ...result, items: [{ ...result.items[0], ...invalid }],
      } } }, request)).toBeNull();
    }
    expect(normalizeClassicBrowseCommandRequest({ ...request, role: "classic-search",
      options: { hierarchy: "search", input: "" } })).toBeNull();
  });
});

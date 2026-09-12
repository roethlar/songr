import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { registerUnifiedSearchSocket } from "../unifiedSearch";

/** Read the real client emit calls, rather than maintaining a second event list. */
function emittedEvents(source: string): string[] {
  const file = ts.createSourceFile("unifiedSearchClient.ts", source, ts.ScriptTarget.Latest, true);
  const events: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(file) === "dependencies" && node.expression.name.text === "emit") {
      const event = node.arguments[1];
      if (!event || !ts.isStringLiteral(event)) throw new Error("Search client event must be explicit");
      events.push(event.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return events;
}

describe("unified search client/server protocol", () => {
  it("registers a real server handler for every request emitted by the shipping client", () => {
    const handlers = new Set<string>();
    const socket = { id: "protocol-check", on: (event: string) => { handlers.add(event); } };
    // Registration never calls Roon. Only the actual server function determines
    // the handler names; the dependency shell supplies no response/event mocks.
    registerUnifiedSearchSocket(
      socket as unknown as Parameters<typeof registerUnifiedSearchSocket>[0],
      {
        coordinator: {}, browseService: {}, zones: { getZone: () => undefined },
        getCoreId: () => null, logger: { error: () => undefined }
      } as unknown as Parameters<typeof registerUnifiedSearchSocket>[1]
    );
    const source = readFileSync(resolve("ui/src/lib/unifiedSearchClient.ts"), "utf8");
    const events = emittedEvents(source);
    expect(events.length).toBeGreaterThan(0);
    expect(events.filter(event => !handlers.has(event))).toEqual([]);
  });
});

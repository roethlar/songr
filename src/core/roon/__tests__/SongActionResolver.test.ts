import {
  SongActionResolutionError,
  SongActionResolver,
} from "../SongActionResolver";

const song = {
  title: "Dear Theodosia",
  subtitle: "Orlando Ballet Chorus",
  itemKey: "raw-song",
  hint: "action_list",
  isLoadable: true,
  isPlayable: false,
};

function result(
  items: Array<{
    title: string;
    itemKey?: string;
    hint?: string;
    isLoadable: boolean;
    isPlayable: boolean;
  }>
) {
  return {
    level: 2,
    offset: 0,
    count: items.length,
    totalCount: items.length,
    items,
  };
}

function session(...pages: ReturnType<typeof result>[]) {
  return {
    browse: jest
      .fn()
      .mockImplementation(() => Promise.resolve(pages.shift())),
    load: jest.fn(),
    pop: jest.fn(),
  };
}

describe("SongActionResolver", () => {
  it.each([
    ["play-now", "raw-play-now"],
    ["add-next", "raw-add-next"],
    ["queue", "raw-queue"],
  ] as const)(
    "resolves %s to its distinct exact leaf",
    async (semantic, expectedKey) => {
      const browse = session(
        result([
          {
            title: "Play Now",
            itemKey: "raw-play-now",
            hint: "action",
            isLoadable: false,
            isPlayable: true,
          },
          {
            title: "Add Next",
            itemKey: "raw-add-next",
            hint: "action",
            isLoadable: false,
            isPlayable: true,
          },
          {
            title: "Queue",
            itemKey: "raw-queue",
            hint: "action",
            isLoadable: false,
            isPlayable: true,
          },
        ])
      );

      await expect(
        new SongActionResolver().resolve(
          browse as never,
          song,
          "zone-1",
          semantic
        )
      ).resolves.toEqual({
        itemKey: expectedKey,
        navigationDepth: 1,
      });
      expect(browse.browse).toHaveBeenCalledTimes(1);
      expect(browse.browse).toHaveBeenCalledWith({
        hierarchy: "search",
        zoneId: "zone-1",
        itemKey: "raw-song",
        pageSize: 33,
      });
    }
  );

  it("follows only one nested action-list row and records its exact depth", async () => {
    const browse = session(
      result([
        {
          title: "More",
          itemKey: "raw-more",
          hint: "action_list",
          isLoadable: true,
          isPlayable: false,
        },
      ]),
      result([
        {
          title: "Queue",
          itemKey: "raw-queue",
          hint: "action",
          isLoadable: false,
          isPlayable: true,
        },
      ])
    );

    await expect(
      new SongActionResolver().resolve(
        browse as never,
        song,
        "zone-1",
        "queue"
      )
    ).resolves.toEqual({
      itemKey: "raw-queue",
      navigationDepth: 2,
    });
  });

  it("rejects duplicate matching leaves instead of guessing", async () => {
    const browse = session(
      result([
        {
          title: "Queue",
          itemKey: "raw-queue-1",
          hint: "action",
          isLoadable: false,
          isPlayable: true,
        },
        {
          title: "Queue",
          itemKey: "raw-queue-2",
          hint: "action",
          isLoadable: false,
          isPlayable: true,
        },
      ])
    );

    await expect(
      new SongActionResolver().resolve(
        browse as never,
        song,
        "zone-1",
        "queue"
      )
    ).rejects.toMatchObject({
      navigationDepth: 1,
    });
  });

  it("marks navigation depth unprovable when a Roon call fails", async () => {
    const failure = new Error("Core stopped responding");
    const browse = session();
    browse.browse.mockRejectedValueOnce(failure);

    await expect(
      new SongActionResolver().resolve(
        browse as never,
        song,
        "zone-1",
        "play-now"
      )
    ).rejects.toEqual(
      expect.objectContaining<
        Pick<SongActionResolutionError, "navigationDepth" | "cause">
      >({
        navigationDepth: null,
        cause: failure,
      })
    );
  });
});

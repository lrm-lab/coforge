/**
 * The shape each version of the stored data has, per fixture, as `fingerprint` computes it from
 * what a fixture stores. Raising `STORED_SHAPE_VERSION` adds a version here with every kind's
 * shape; an earlier version's entry is history and stays as it was.
 */
export const PINNED_SHAPES: Record<number, Record<string, string>> = {
  1: {
    "channel window": "2f68f20584a2fb7b",
    "direct window with an Agent": "2d10aa5a9e972ac8",
    "direct window with a person": "085473f1d4a4eda8",
    "sidebar channels": "0b5b17a03f4362f8",
    "sidebar directs": "d5303ed35079d99a",
    "channel names": "331d221481674004",
    "saved messages": "da415c7e82ad6579",
  },
  // A reaction's reactors are `{ id, label }`, not the `@handle` strings they were, and a window
  // no longer carries the viewer's handle.
  2: {
    "channel window": "44676fdb14e4f430",
    "direct window with an Agent": "97ae348e063eecb4",
    "direct window with a person": "0d0d6367b901566a",
    "sidebar channels": "0b5b17a03f4362f8",
    "sidebar directs": "d5303ed35079d99a",
    "channel names": "331d221481674004",
    "saved messages": "af3437c73adfddaa",
  },
  // A DM row carries its last message's time and preview (both required, `null` with no message).
  3: {
    "channel window": "44676fdb14e4f430",
    "direct window with an Agent": "97ae348e063eecb4",
    "direct window with a person": "0d0d6367b901566a",
    "sidebar channels": "0b5b17a03f4362f8",
    "sidebar directs": "5205999212e744be",
    "channel names": "331d221481674004",
    "saved messages": "af3437c73adfddaa",
  },
  // A channel row carries its last message (`null` with none), its collage members and whether the
  // viewer is mentioned in it.
  4: {
    "channel window": "44676fdb14e4f430",
    "direct window with an Agent": "97ae348e063eecb4",
    "direct window with a person": "0d0d6367b901566a",
    "sidebar channels": "91afa2f21eb4ec87",
    "sidebar directs": "5205999212e744be",
    "channel names": "331d221481674004",
    "saved messages": "af3437c73adfddaa",
  },
  // A person carries `displayName` only. (A Computer's Agent workspace scan was added as a kind.)
  5: {
    "channel window": "e7aded67e38ffb44",
    "direct window with an Agent": "1e846d0c6032fceb",
    "direct window with a person": "711cea7f597cd9a3",
    "sidebar channels": "91afa2f21eb4ec87",
    "sidebar directs": "5205999212e744be",
    "channel names": "331d221481674004",
    "saved messages": "af3437c73adfddaa",
    "agent workspace scan": "d45d053aa4368e73",
    // A member's sections and their order were added as kinds.
    "chat sections": "4c7716ab24622fdc",
    "chat section order": "89829726781b01aa",
  },
  // A direct conversation's message carries `senderMemberId`, as a channel's does: it alone tells
  // the viewer's own messages, so a stored DM page without it would read nobody's as theirs.
  6: {
    "channel window": "e7aded67e38ffb44",
    "direct window with an Agent": "dd470007a536e5b0",
    "direct window with a person": "4b31a9f0b0c38386",
    "sidebar channels": "91afa2f21eb4ec87",
    "sidebar directs": "5205999212e744be",
    "channel names": "331d221481674004",
    "saved messages": "af3437c73adfddaa",
    "agent workspace scan": "d45d053aa4368e73",
    "chat sections": "4c7716ab24622fdc",
    "chat section order": "89829726781b01aa",
  },
  // An Agent's `avatarUrl` is never `null`: one without its own upload carries the default picture.
  7: {
    "channel window": "e7aded67e38ffb44",
    "direct window with an Agent": "1725081943acee05",
    "direct window with a person": "4b31a9f0b0c38386",
    "sidebar channels": "91afa2f21eb4ec87",
    "sidebar directs": "5205999212e744be",
    "channel names": "331d221481674004",
    "saved messages": "af3437c73adfddaa",
    "agent workspace scan": "d45d053aa4368e73",
    "chat sections": "4c7716ab24622fdc",
    "chat section order": "89829726781b01aa",
  }, // An Agent's `avatarUrl` is a platform mascot's: the route that served an uploaded picture is gone,
  // so a stored URL for it would no longer load. The shapes are those of version 7.
  8: {
    "channel window": "e7aded67e38ffb44",
    "direct window with an Agent": "1725081943acee05",
    "direct window with a person": "4b31a9f0b0c38386",
    "sidebar channels": "91afa2f21eb4ec87",
    "sidebar directs": "5205999212e744be",
    "channel names": "331d221481674004",
    "saved messages": "af3437c73adfddaa",
    "agent workspace scan": "d45d053aa4368e73",
    "chat sections": "4c7716ab24622fdc",
    "chat section order": "89829726781b01aa",
  },
  // A person's `avatarUrl` is never `null` either: one with no avatar carries the cartoon person
  // their id chooses, and the thirty portrait photos a stored URL could name are gone.
  9: {
    "channel window": "311f6b99684eed2c",
    "direct window with an Agent": "409b90398ef4884e",
    "direct window with a person": "7adde1efb9396169",
    "sidebar channels": "91afa2f21eb4ec87",
    "sidebar directs": "5205999212e744be",
    "channel names": "331d221481674004",
    "saved messages": "af3437c73adfddaa",
    "agent workspace scan": "d45d053aa4368e73",
    "chat sections": "4c7716ab24622fdc",
    "chat section order": "89829726781b01aa",
  },
  10: {
    "channel window": "bee52e3753bc63fa",
    "direct window with an Agent": "cfb56f0008e53e3a",
    "direct window with a person": "8ffc1a72c5a7dfd6",
    "sidebar channels": "91afa2f21eb4ec87",
    "sidebar directs": "5205999212e744be",
    "channel names": "331d221481674004",
    "saved messages": "af3437c73adfddaa",
    "agent workspace scan": "d45d053aa4368e73",
    "chat sections": "4c7716ab24622fdc",
    "chat section order": "89829726781b01aa",
  },
  // A member's sections and their order carry the stream position of their own signal channel,
  // which announces their changes: the sections beside it as `sections`, the order as `order`.
  11: {
    "channel window": "bee52e3753bc63fa",
    "direct window with an Agent": "cfb56f0008e53e3a",
    "direct window with a person": "8ffc1a72c5a7dfd6",
    "sidebar channels": "91afa2f21eb4ec87",
    "sidebar directs": "5205999212e744be",
    "channel names": "331d221481674004",
    "saved messages": "af3437c73adfddaa",
    "agent workspace scan": "d45d053aa4368e73",
    "chat sections": "b49b26a074dbffb9",
    "chat section order": "fc37a20be1db425d",
  },
  // A channel's visibility is required wherever a kept kind names a channel (task #376): the
  // channel window, the sidebar's channels, every channel's name and a saved message's channel.
  12: {
    "channel window": "b1d091db9cdd9119",
    "direct window with an Agent": "cfb56f0008e53e3a",
    "direct window with a person": "8ffc1a72c5a7dfd6",
    "sidebar channels": "71e962a71254dad3",
    "sidebar directs": "5205999212e744be",
    "channel names": "292a0fa92b3cbad1",
    "saved messages": "29e083a65a909ec0",
    "agent workspace scan": "d45d053aa4368e73",
    "chat sections": "b49b26a074dbffb9",
    "chat section order": "fc37a20be1db425d",
  },
  // A conversation window no longer carries the viewer's read cursor (task #378).
  13: {
    "channel window": "eea5d9e2a379995a",
    "direct window with an Agent": "2fee8267523e1b97",
    "direct window with a person": "0906fd265d7973a6",
    "sidebar channels": "71e962a71254dad3",
    "sidebar directs": "5205999212e744be",
    "channel names": "292a0fa92b3cbad1",
    "saved messages": "29e083a65a909ec0",
    "agent workspace scan": "d45d053aa4368e73",
    "chat sections": "b49b26a074dbffb9",
    "chat section order": "fc37a20be1db425d",
  },
  // Agent workspace inventory now stores only directory identity and modification time.
  14: {
    "channel window": "eea5d9e2a379995a",
    "direct window with an Agent": "2fee8267523e1b97",
    "direct window with a person": "0906fd265d7973a6",
    "sidebar channels": "71e962a71254dad3",
    "sidebar directs": "5205999212e744be",
    "channel names": "292a0fa92b3cbad1",
    "saved messages": "29e083a65a909ec0",
    "agent workspace scan": "33c25ace40102710",
    "chat sections": "b49b26a074dbffb9",
    "chat section order": "fc37a20be1db425d",
  },
  // Agent workspace inventory now also carries recursive file count and total size.
  15: {
    "channel window": "eea5d9e2a379995a",
    "direct window with an Agent": "2fee8267523e1b97",
    "direct window with a person": "0906fd265d7973a6",
    "sidebar channels": "71e962a71254dad3",
    "sidebar directs": "5205999212e744be",
    "channel names": "292a0fa92b3cbad1",
    "saved messages": "29e083a65a909ec0",
    "agent workspace scan": "d45d053aa4368e73",
    "chat sections": "b49b26a074dbffb9",
    "chat section order": "fc37a20be1db425d",
  },
  // The inventory also stores each workspace's statistics state, so a restored listing shows
  // whether its budgeted measurements are still on the way (task #379).
  16: {
    "channel window": "eea5d9e2a379995a",
    "direct window with an Agent": "2fee8267523e1b97",
    "direct window with a person": "0906fd265d7973a6",
    "sidebar channels": "71e962a71254dad3",
    "sidebar directs": "5205999212e744be",
    "channel names": "292a0fa92b3cbad1",
    "saved messages": "29e083a65a909ec0",
    "agent workspace scan": "be4265c651dc4bff",
    "chat sections": "b49b26a074dbffb9",
    "chat section order": "fc37a20be1db425d",
  },
  // A workspace row no longer says its directory is missing: the scan lists only the directories
  // the Computer has, as Raft's does, so a stored row reading "missing" is not one to open at.
  17: {
    "channel window": "eea5d9e2a379995a",
    "direct window with an Agent": "2fee8267523e1b97",
    "direct window with a person": "0906fd265d7973a6",
    "sidebar channels": "71e962a71254dad3",
    "sidebar directs": "5205999212e744be",
    "channel names": "292a0fa92b3cbad1",
    "saved messages": "29e083a65a909ec0",
    "agent workspace scan": "be4265c651dc4bff",
    "chat sections": "b49b26a074dbffb9",
    "chat section order": "fc37a20be1db425d",
  },
};

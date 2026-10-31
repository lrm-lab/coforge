import { expect, test } from "bun:test";

import {
  decodeRecordChangedEvent,
  type RecordChangedEvent,
} from "#src/features/records/record-realtime";
import { isRecordsMatch } from "#src/features/records/use-record-refresh";

/**
 * Task #366: a change on a record's page reloads the Records pages it touched, not the Workspace
 * around them, and a report's page reads itself again only on its own `record.changed.v1`.
 */
test("the Records pages are the catalog layout and every page under it", () => {
  for (const routeId of [
    "/w/$workspaceSlug/records",
    "/w/$workspaceSlug/records/",
    "/w/$workspaceSlug/records/$recordId",
    "/w/$workspaceSlug/records/weeks/$year/$week",
  ])
    expect(isRecordsMatch({ routeId })).toBe(true);
  for (const routeId of ["__root__", "/w/$workspaceSlug", "/w/$workspaceSlug/recordsets"])
    expect(isRecordsMatch({ routeId })).toBe(false);
});

test("a report change decodes; any other publication on the channel is not one", () => {
  const event: RecordChangedEvent = {
    type: "record.changed.v1",
    workspaceId: "workspace",
    reportId: "report",
  };
  expect(decodeRecordChangedEvent(event)).toEqual(event);
  expect(decodeRecordChangedEvent({ type: "task.changed.v1", reportId: "report" })).toBeUndefined();
  expect(decodeRecordChangedEvent({ type: "record.changed.v1", reportId: "" })).toBeUndefined();
  expect(decodeRecordChangedEvent(new Uint8Array([1, 2]))).toBeUndefined();
  expect(decodeRecordChangedEvent(null)).toBeUndefined();
});

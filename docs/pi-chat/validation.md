# AI workbench validation

UI acceptance follows [the repository policy](../agents/testing.md). Before deployment:

- [ ] Verify the navigation and list/detail flow at desktop and mobile sizes,
  in both themes, including direct links and returning to the list.
- [ ] Search across date groups, clear a no-results query, and check both languages.
- [ ] Expand process details and tool input/output; verify a failed tool remains
  indicated when collapsed, and all output/diff/patch text remains available.
- [ ] Copy a reply, code block and tool result; verify the clipboard and feedback.
- [ ] Scroll up during a reply, load earlier history, switch chats and return;
  verify reading position, expanded details, loaded pages and drafts. Expand long
  details at the bottom and confirm the disclosure stays in view. Resume with Back to latest.
- [ ] Type long/multiline text; verify composer growth, Enter, Shift+Enter and IME.
- [ ] Open the conversation menu with keyboard and touch; rename and cancel delete.
- [ ] Start two chats; verify independent context, actual model display,
  Markdown/code rendering, and drafts retained when switching conversations.
- [ ] Verify complete edit diffs and patches survive switching chats and reloading.
- [ ] Fail the first send with missing model credentials, repair the credentials,
  and verify a new message continues the same chat without replaying the failure.
- [ ] Stop, rename, cancel deletion, confirm deletion from both menus, and reload.
- [ ] Queue Steer/Follow-up during a tool, take back pending text with Alt+Up,
  then switch model while idle; verify queued ordering and model persistence.
- [ ] Delay history refresh with realtime disconnected; accepted text stays visible, Stop appears
  immediately, and another send uses Steer/Follow-up. Verify no duplicates after refresh and no
  regression to running after a delayed send reply arrives behind a newer terminal state.
- [ ] Disconnect/reconnect while sending; retry the same message without
  duplicate tool execution. Switch Users/Workspaces and verify isolation.
- [ ] Open/resize/close the file sidebar; browse nested folders and hidden files,
  preview text/Markdown/code/images, download binary content, upload a file over
  192 KB, and reference it in the composer. Check empty/error/10 MB limit states,
  local answer links, mobile drawer Escape/overlay, and upgrade capability refresh.
- [ ] Check unavailable configuration, an old host/image, offline Computer,
  model authentication failure, worker restart and keyboard/IME behavior.

/** The Tasks guidance for a Workspace with task conversations on: a task is a place people and
 * Agents talk in, not only a claim on a message. */
export const TASK_CONVERSATIONS_SECTION = `## Tasks have their own conversations
A task has its own conversation, named by a ref: \`#channel:#7\` (or \`dm:@name:#7\`). ALWAYS quote the ref in the shell; an unquoted # starts a comment. Messages from it arrive with \`target=<ref>\`.
Start with \`coforge task view '<ref>'\`. Reply with \`coforge task reply '<ref>'\` (body on stdin; \`--mention\`, \`--attachment-id\`). Read with \`coforge task read '<ref>' [--unread]\`. \`coforge task follow|unfollow '<ref>'\`; \`coforge task list --following\`. \`message send\` and \`message read\` do not take task refs.
Replying, being assigned, claiming or being @mentioned in a task follows it, and its replies wake you. Creating a task posts no chat message. \`coforge task create --message-id <id>\` links a task to a channel message; one message may have several tasks, and \`--alongside\` adds one beside someone else's live task.
Answer people where they spoke. Someone who only wrote the source message is answered in that message's thread (\`coforge message send --target '#chan:<8-char id>'\`); someone who created the task or wrote in its conversation is answered there.
Assignee is who the task waits on now; status is how far it got. For review set in_review and assign the reviewer. For acceptance set in_review, assign the asker and tell them where they spoke.`;

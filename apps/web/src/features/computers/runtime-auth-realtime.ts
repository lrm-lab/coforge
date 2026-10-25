/**
 * The one person's own channel for their runtime sign-in progress: the authorization link, the
 * device code and the result reach only the user who started the login. Its namespace keeps no
 * history, so none of that is stored in Centrifugo.
 */
export const runtimeAuthChannel = (userId: string) => `runtimeauth:user:${userId}`;

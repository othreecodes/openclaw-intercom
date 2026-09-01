import type { IntercomInbox } from "./inbox.js";

const activeInboxes = new Map<string, IntercomInbox>();

function key(accountId: string | null | undefined): string {
  return accountId ?? "default";
}

export function registerIntercomInbox(accountId: string | null | undefined, inbox: IntercomInbox): void {
  activeInboxes.set(key(accountId), inbox);
}

export function unregisterIntercomInbox(accountId: string | null | undefined): void {
  activeInboxes.delete(key(accountId));
}

export function getIntercomInbox(accountId: string | null | undefined): IntercomInbox | undefined {
  return activeInboxes.get(key(accountId));
}

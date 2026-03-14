const MAX_SIZE = 1000;

export class MessageDedup {
  private processed = new Set<string>();

  isDuplicate(messageId: string): boolean {
    if (this.processed.has(messageId)) return true;
    this.processed.add(messageId);
    if (this.processed.size > MAX_SIZE) this.processed.clear();
    return false;
  }
}

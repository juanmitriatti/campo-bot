import type { UserId, User, ParsedCommand, UserSettings } from '../../types/index.js';

export class LivestockHandler {
  async handleCommand(
    _cmd: ParsedCommand,
    _userId: UserId,
    _phone: string,
    _user: User,
    _settings: UserSettings
  ): Promise<boolean> {
    // Stub for future livestock vertical
    // Returns false to indicate the command was not handled
    return false;
  }
}

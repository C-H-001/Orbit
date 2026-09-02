export class OperationLockLostError extends Error {
  constructor() {
    super("Mail-processing lock was lost");
  }
}

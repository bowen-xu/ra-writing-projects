/** Raised only by a read-only preflight after proving no application journal exists. */
export class WritingDeliveryConflict extends Error {
  constructor() { super("The unapplied proposal no longer matches the current file."); }
}

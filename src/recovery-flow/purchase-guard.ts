export interface PurchaseGuardKey {
  taskId: string;
  provider: string;
  planId: string;
}

export class PurchaseGuard {
  private readonly executedPurchases =
    new Set<string>();

  /**
   * Returns true when this purchase has not been
   * executed or reserved yet.
   */
  canPurchase(
    key: PurchaseGuardKey,
  ): boolean {
    return !this.executedPurchases.has(
      this.createKey(key),
    );
  }

  /**
   * Mark a purchase as completed.
   */
  markPurchased(
    key: PurchaseGuardKey,
  ): void {
    this.executedPurchases.add(
      this.createKey(key),
    );
  }

  /**
   * Reserve a purchase so that duplicate requests
   * cannot execute concurrently.
   */
  acquire(
    key: PurchaseGuardKey,
  ): boolean {
    const normalizedKey = this.createKey(key);

    if (this.executedPurchases.has(normalizedKey)) {
      return false;
    }

    this.executedPurchases.add(
      normalizedKey,
    );

    return true;
  }

  /**
   * Release a purchase reservation.
   *
   * This is appropriate when the purchase provider
   * explicitly reports FAILED.
   */
  release(
    key: PurchaseGuardKey,
  ): void {
    this.executedPurchases.delete(
      this.createKey(key),
    );
  }

  private createKey(
    key: PurchaseGuardKey,
  ): string {
    return [
      key.taskId,
      key.provider,
      key.planId,
    ].join(":");
  }
}
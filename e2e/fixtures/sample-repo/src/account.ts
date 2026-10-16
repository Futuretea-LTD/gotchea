export class Account {
  private balance = 0;

  deposit(amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) throw new RangeError('Invalid deposit');
    this.balance += amount;
    return this.balance;
  }

  withdraw(amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0 || amount > this.balance) return false;
    this.balance -= amount;
    return true;
  }

  getBalance(): number {
    return this.balance;
  }
}

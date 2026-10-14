import { slugify } from '../util/strings.js';

export type Role = 'admin' | 'member' | 'guest';

export class User {
  constructor(
    readonly id: string,
    public name: string,
    public role: Role = 'member',
  ) {}

  get handle(): string {
    return slugify(this.name);
  }

  isAdmin(): boolean {
    return this.role === 'admin';
  }

  promote(): void {
    if (this.role === 'guest') this.role = 'member';
    else if (this.role === 'member') this.role = 'admin';
  }
}

export function createUser(name: string, role?: Role): User {
  const id = `u_${slugify(name)}`;
  return new User(id, name, role);
}

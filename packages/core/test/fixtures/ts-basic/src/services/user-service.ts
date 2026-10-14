import { User, createUser, type Role } from '../models/user.js';
import { clamp } from '../util/math.js';
import { slugify, truncate } from '../util/strings.js';

export class UserService {
  private readonly users = new Map<string, User>();

  register(name: string, role?: Role): User {
    const user = createUser(truncate(name, 64), role);
    if (this.users.has(user.id)) {
      throw new Error(`duplicate user ${user.id}`);
    }
    this.users.set(user.id, user);
    return user;
  }

  find(name: string): User | undefined {
    return this.users.get(`u_${slugify(name)}`);
  }

  page(offset: number, size: number): User[] {
    const all = [...this.users.values()];
    const start = clamp(offset, 0, all.length);
    return all.slice(start, start + clamp(size, 1, 100));
  }

  admins(): User[] {
    return [...this.users.values()].filter((u) => u.isAdmin());
  }
}
